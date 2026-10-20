//! SR-R2500P（Bluetooth SPP）への対話的な送信。手順は labelbridge::srr2500p を参照。
//!
//! 接続先:
//! - 既定（macOS）: 中継アプリ tools/bt-bridge（target/BTBridge.app）を起動し、Unix ソケット経由で話す。
//!   `/dev/cu.SR-R2500P` は閉じるとリンクが戻らなかったり iAP 側のチャネルに繋がったりして安定しないため。
//!   アプリの場所は環境変数 `LABELBRIDGE_BT_BRIDGE` で変えられる。
//! - `--port /dev/...`: シリアルデバイスを直接開く（Linux の rfcomm bind など）。

use std::fmt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use labelbridge::srr2500p::{JobParts, STATUS_AUTO, STATUS_LEN, STATUS_ONCE};
use labelbridge::{DriverError, PrinterDriver, PrinterStatus, SrR2500p, cmd};
use labelbridge_transport::serial::SerialTransport;
use labelbridge_transport::unix::UnixTransport;
use labelbridge_transport::{Transport, TransportError};

pub const DEFAULT_DEVICE: &str = "SR-R2500P";

/// このモジュールのエラー。タイムアウトは文字列ではなく [`BtError::Timeout`] で見分ける。
#[derive(Debug)]
pub enum BtError {
    /// ステータスが期限までに届かなかった。
    Timeout,
    /// 送受信の失敗（`what` は何をしていたか）。
    Transport {
        what: &'static str,
        source: TransportError,
    },
    /// ステータスフレームを解釈できなかった。
    Status(DriverError),
    /// プリンターがエラーを報告した。
    Printer(u8),
    /// 接続できなかった・テープ不一致など。
    Other(String),
}

impl fmt::Display for BtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => f.write_str("timed out waiting for status"),
            Self::Transport { what, source } => write!(f, "{what}: {source}"),
            Self::Status(e) => write!(f, "status: {e}"),
            Self::Printer(e) => write!(f, "printer error {e:#04x}"),
            Self::Other(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for BtError {}

impl From<String> for BtError {
    fn from(s: String) -> Self {
        Self::Other(s)
    }
}

struct Session<'a> {
    // フィールドは宣言順に drop される。先にソケットを閉じ（中継アプリは切断で自分から終わる）、
    // その後で Bridge が残ったプロセスと一時ファイルを片付ける。
    t: Box<dyn Transport>,
    _bridge: Option<Bridge>,
    driver: &'a SrR2500p,
    buf: Vec<u8>,
    last: String,
}

impl<'a> Session<'a> {
    fn open(target: &str, driver: &'a SrR2500p) -> Result<Self, BtError> {
        let (t, bridge) = connect(target)?;
        Ok(Self {
            t,
            _bridge: bridge,
            driver,
            buf: Vec::new(),
            last: String::new(),
        })
    }

    fn send(&mut self, what: &'static str, b: &[u8]) -> Result<(), BtError> {
        self.t
            .write_all(b)
            .map_err(|source| BtError::Transport { what, source })
    }

    /// 次のステータスフレームを待つ。届いたフレームのうち最後のものを返す。
    fn wait_status(&mut self, timeout: Duration) -> Result<PrinterStatus, BtError> {
        let deadline = Instant::now() + timeout;
        let mut chunk = [0u8; 1024];
        loop {
            if let Some(start) = self.buf.windows(8).position(|w| w == b"@BDC ST2")
                && self.buf.len() >= start + STATUS_LEN
            {
                let frame: Vec<u8> = self.buf.drain(..start + STATUS_LEN).skip(start).collect();
                let s = self.driver.parse_status(&frame).map_err(BtError::Status)?;
                let line = describe(&s);
                if line != self.last {
                    eprintln!("status: {line}");
                    self.last = line;
                }
                return Ok(s);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(BtError::Timeout);
            }
            match self.t.read(&mut chunk, left) {
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(TransportError::Timeout) => return Err(BtError::Timeout),
                Err(source) => {
                    return Err(BtError::Transport {
                        what: "status",
                        source,
                    });
                }
            }
        }
    }

    fn check(&mut self, timeout: Duration) -> Result<PrinterStatus, BtError> {
        let s = self.wait_status(timeout)?;
        match s.error_code {
            Some(e) => Err(BtError::Printer(e)),
            None => Ok(s),
        }
    }
}

fn describe(s: &PrinterStatus) -> String {
    let body = s.raw.get(14..17).unwrap_or_default();
    format!(
        "ST:{:02X} ER:{:02X} TW:{:02X} ({})",
        body.first().copied().unwrap_or(0),
        body.get(1).copied().unwrap_or(0),
        body.get(2).copied().unwrap_or(0),
        s.tape_width_mm
            .map_or("no tape".into(), |w| format!("{w}mm"))
    )
}

/// 中継アプリの後始末。drop で起動したプロセスを終わらせ、ソケットとログを消す。
struct Bridge {
    sock: PathBuf,
    log: PathBuf,
    pid: Option<u32>,
}

impl Bridge {
    fn new() -> Self {
        let dir = std::env::temp_dir();
        let id = std::process::id();
        Self {
            sock: dir.join(format!("labelbridge-bt-{id}.sock")),
            log: dir.join(format!("labelbridge-bt-{id}.log")),
            pid: None,
        }
    }

    /// `open` は起動したプロセスの PID を返さないので、ソケットのパス（引数に入る）で探す。
    fn find_pid(&mut self) {
        if self.pid.is_some() {
            return;
        }
        let Ok(out) = std::process::Command::new("pgrep")
            .arg("-f")
            .arg(&self.sock)
            .output()
        else {
            return;
        };
        let me = std::process::id();
        self.pid = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .find(|&p| p != me);
    }
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.find_pid();
        if let Some(pid) = self.pid {
            // 接続済みなら切断で自分から終わるので少し待つ。残っていれば SIGTERM
            let deadline = Instant::now() + Duration::from_secs(1);
            while alive(pid) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            if alive(pid) {
                let _ = std::process::Command::new("kill")
                    .arg(pid.to_string())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
        let _ = std::fs::remove_file(&self.sock);
        let _ = std::fs::remove_file(&self.log);
    }
}

/// `/dev/` で始まればシリアルデバイス、それ以外は機器名（またはアドレス）として中継アプリで繋ぐ。
/// 中継アプリを使ったときは、その後始末役も返す（接続を閉じた後に drop すること）。
fn connect(target: &str) -> Result<(Box<dyn Transport>, Option<Bridge>), BtError> {
    if target.starts_with("/dev/") {
        let t = SerialTransport::open(target).map_err(|e| format!("{target}: {e}"))?;
        return Ok((Box::new(t), None));
    }
    let app =
        std::env::var("LABELBRIDGE_BT_BRIDGE").unwrap_or_else(|_| "target/BTBridge.app".into());
    // ビルド: tools/bt-bridge/build.sh（リポジトリのルートで実行すると target/BTBridge.app ができる）
    if !std::path::Path::new(&app).exists() {
        return Err(format!("{app} not found; build it with tools/bt-bridge/build.sh").into());
    }
    let mut bridge = Bridge::new();
    let _ = std::fs::remove_file(&bridge.sock);
    let launched = std::process::Command::new("open")
        .args(["-n", &app, "--stderr"])
        .arg(&bridge.log)
        .arg("--args")
        .arg(target)
        .arg(&bridge.sock)
        .status()
        .map_err(|e| format!("open {app}: {e}"))?;
    if !launched.success() {
        return Err(format!("open {app}: {launched}").into());
    }
    eprintln!("connecting to {target} via {app} …");
    // 中継アプリは RFCOMM を最大 5 回（途中でベースバンドも張り直す）試すので、1 分強かかることがある。
    // 途中で打ち切ると再試行の機会を潰すため、中継アプリが諦めて終わるまで待つ（上限 90 秒）。
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut last_progress = Instant::now();
    while Instant::now() < deadline {
        bridge.find_pid();
        if let Ok(t) = UnixTransport::connect(&bridge.sock) {
            bridge.find_pid();
            return Ok((Box::new(t), Some(bridge)));
        }
        if bridge.pid.is_some_and(|pid| !alive(pid)) {
            break; // 中継アプリが諦めて終了した
        }
        if last_progress.elapsed() > Duration::from_secs(15) {
            eprintln!("  still connecting …");
            last_progress = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let detail = std::fs::read_to_string(&bridge.log).unwrap_or_default();
    let detail = detail.trim();
    let hint = if detail.is_empty() {
        "the bridge wrote nothing. Check that the printer is on and paired, and that macOS allows Bluetooth for BTBridge.app \
         (System Settings > Privacy & Security > Bluetooth; the permission is asked again after the app is rebuilt)"
    } else {
        detail
    };
    // ここで bridge が drop され、プロセスと一時ファイルが片付く
    Err(format!("Bluetooth bridge did not come up: {hint}").into())
}

/// 単発のステータス取得（印字はしない）。
pub fn status(target: &str, driver: &SrR2500p) -> Result<PrinterStatus, BtError> {
    let mut s = Session::open(target, driver)?;
    s.send("status", &STATUS_ONCE)?;
    s.wait_status(Duration::from_secs(10))
}

pub fn send(
    target: &str,
    driver: &SrR2500p,
    parts: &JobParts,
    tape_mm: u32,
) -> Result<(), BtError> {
    let mut s = Session::open(target, driver)?;
    let result = run(&mut s, parts, tape_mm);
    // 後始末: 自動通知を OFF に戻す（成否にかかわらず）
    let _ = s.send("status off", &STATUS_ONCE);
    let _ = s.wait_status(Duration::from_secs(2));
    result
}

fn run(s: &mut Session, p: &JobParts, tape_mm: u32) -> Result<(), BtError> {
    // 参考手順では最初に ESC{!}（リセット）を送るが、macOS + SR-R2500P では
    // 送った直後に Bluetooth リンクが切れ、本体の電源を入れ直すまで戻らなかった（実機）。
    // リセットは送らない。
    s.send("status auto", &STATUS_AUTO)?;
    let first = s.check(Duration::from_secs(15)).map_err(|e| {
        BtError::Other(format!(
            "{e} (is the printer on and not connected to another device?)"
        ))
    })?;
    if first.tape_width_mm != Some(tape_mm) {
        return Err(format!(
            "tape mismatch: job {tape_mm}mm, loaded {}; nothing printed",
            first
                .tape_width_mm
                .map_or("none".into(), |w| format!("{w}mm"))
        )
        .into());
    }

    s.send("job environment", &p.environment)?;
    s.send("status auto", &STATUS_AUTO)?;
    s.check(Duration::from_secs(15))?;

    for copy in 0..p.copies {
        s.send("page environment", &p.page_environment)?;
        for (i, band) in p.bands.iter().enumerate() {
            s.send("raster", band)?;
            eprintln!(
                "sent band {}/{} (copy {}/{})",
                i + 1,
                p.bands.len(),
                copy + 1,
                p.copies
            );
            match s.check(Duration::from_secs(60)) {
                Ok(_) => {}
                // 印字中は通知が遅れることがある。届かなくても次の帯へ進む
                Err(BtError::Timeout) => {}
                Err(e) => return Err(e),
            }
        }
        s.send("form feed", &[cmd::FORM_FEED])?;
    }
    s.send("print end", &p.end)?;
    // 印字が終わって待機に戻るまで見届ける
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let st = s.check(Duration::from_secs(60))?;
        if !st.busy || std::time::Instant::now() > deadline {
            break;
        }
    }
    Ok(())
}
