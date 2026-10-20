//! SR5900P（LAN）への送信。手順は hikalium/sr5900p の実装と同じ:
//! 状態(1) → 印刷開始(2) → 0.5 秒 → TCP 9100 接続 → 0.5 秒 → 0x0101/0x0100 → 0.5 秒
//! → データ送信 → 0.5 秒ごとに状態を確認（印字中の間）→ 印刷終了(3)。

use std::time::Duration;

use labelbridge::{PrinterDriver, PrinterStatus, Sr5900p};
use labelbridge_transport::Transport;
use labelbridge_transport::tprt::{
    CMD_NOTIFY_1, CMD_NOTIFY_2, CMD_START, CMD_STATUS, CMD_STOP, DataStream, TprtClient,
};

fn client(host: &str) -> Result<TprtClient, String> {
    TprtClient::new(host, Duration::from_secs(3)).map_err(|e| format!("{host}: {e}"))
}

fn query(c: &TprtClient) -> Result<PrinterStatus, String> {
    let data = c.request(CMD_STATUS).map_err(|e| format!("status: {e}"))?;
    Sr5900p::default()
        .parse_status(&data)
        .map_err(|e| e.to_string())
}

pub fn describe(s: &PrinterStatus) -> String {
    format!(
        "ST:{:02X} ER:{:02X} TW:{:02X} ({})",
        s.raw.get(1).copied().unwrap_or(0),
        s.raw.get(2).copied().unwrap_or(0),
        s.raw.get(3).copied().unwrap_or(0),
        s.tape_width_mm
            .map_or("no tape".into(), |w| format!("{w}mm"))
    )
}

/// 単発のステータス取得（印字はしない）。
pub fn status(host: &str) -> Result<PrinterStatus, String> {
    query(&client(host)?)
}

pub fn send(host: &str, bytes: &[u8], tape_mm: u32) -> Result<(), String> {
    let c = client(host)?;
    let first = query(&c)?;
    eprintln!("status: {}", describe(&first));
    if let Some(e) = first.error_code {
        return Err(format!("printer error {e:#04x}; nothing sent"));
    }
    if first.busy {
        return Err("printer is busy; nothing sent".into());
    }
    if first.tape_width_mm != Some(tape_mm) {
        return Err(format!(
            "tape mismatch: job {tape_mm}mm, loaded {}; nothing sent",
            first
                .tape_width_mm
                .map_or("none".into(), |w| format!("{w}mm"))
        ));
    }

    let r = c.request(CMD_START).map_err(|e| format!("start: {e}"))?;
    if r != [2, 0, 0] {
        return Err(format!("unexpected response to start: {r:02x?}"));
    }
    let pause = || std::thread::sleep(Duration::from_millis(500));
    // ここから先で失敗しても、印刷終了(3) を送ってプリンターを解放する
    let result = (|| {
        pause();
        let mut data =
            DataStream::connect(host, Duration::from_secs(5)).map_err(|e| format!("tcp: {e}"))?;
        pause();
        c.request(CMD_NOTIFY_1)
            .map_err(|e| format!("notify: {e}"))?;
        let r = c
            .request(CMD_NOTIFY_2)
            .map_err(|e| format!("notify: {e}"))?;
        if r != [0x10] && r != [0x00] {
            return Err(format!("unexpected response to notify: {r:02x?}"));
        }
        pause();
        data.write_all(bytes)
            .map_err(|e| format!("tcp write: {e}"))?;
        eprintln!("sent {} bytes", bytes.len());

        // 印字中（ST ≠ 0）を見てから待機に戻るまで待つ。印字が始まらないまま 8 秒経ったら終わる
        let started = std::time::Instant::now();
        let mut last = String::new();
        let mut seen_busy = false;
        loop {
            pause();
            let s = query(&c)?;
            let line = describe(&s);
            if line != last {
                eprintln!("status: {line}");
                last = line;
            }
            if let Some(e) = s.error_code {
                return Err(format!("printer error {e:#04x}"));
            }
            if s.busy {
                seen_busy = true;
            } else if seen_busy || started.elapsed() > Duration::from_secs(8) {
                return Ok(());
            }
            if started.elapsed() > Duration::from_secs(120) {
                return Err("printer did not finish within 120 s".into());
            }
        }
    })();
    let stop = c.request(CMD_STOP).map_err(|e| format!("stop: {e}"));
    result?;
    stop.map(|_| ())
}
