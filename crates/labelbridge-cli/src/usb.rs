//! SR3500P（USB）への送信と状態取得。
//! ジョブ前に SOFT_RESET → Selected 待ちを行う（docs/protocol.md §2（ジョブの前の準備））
//! （省くと 2 回目以降のジョブが無視される）。複数枚は 1 枚ごとにこれを繰り返す。

use std::time::Duration;

use labelbridge::sr3500p::STATUS_LEN;
use labelbridge::{PrinterDriver, PrinterStatus, Sr3500p};
use labelbridge_transport::Transport;
use labelbridge_transport::usb::UsbTransport;

fn open(driver: &Sr3500p) -> Result<UsbTransport, String> {
    let caps = driver.capabilities();
    let (Some(vid), Some(pid)) = (caps.usb_vendor_id, caps.usb_product_id) else {
        return Err("USB ID unknown for this model".into());
    };
    UsbTransport::open(vid, pid).map_err(|e| format!("open USB {vid:04x}:{pid:04x}: {e}"))
}

fn prepare(t: &mut UsbTransport) -> Result<(), String> {
    t.soft_reset().map_err(|e| format!("soft reset: {e}"))?;
    for _ in 0..10 {
        if t.port_status().is_ok_and(|s| s & 0x10 != 0) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Err("printer did not become selected after soft reset".into())
}

fn query(driver: &Sr3500p, t: &mut UsbTransport) -> Result<PrinterStatus, String> {
    // bulk IN はパケット長（64 バイト）ちょうどで要求する（docs/protocol.md §2）
    let mut buf = [0u8; STATUS_LEN];
    while t.read(&mut buf, Duration::from_millis(30)).is_ok() {}
    t.write_all(&driver.status_request().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut got = Vec::new();
    while got.len() < STATUS_LEN {
        let n = t
            .read(&mut buf, Duration::from_millis(1000))
            .map_err(|e| format!("status: {e}"))?;
        got.extend_from_slice(&buf[..n]);
    }
    driver.parse_status(&got).map_err(|e| e.to_string())
}

pub fn describe(s: &PrinterStatus) -> String {
    let text = String::from_utf8_lossy(&s.raw);
    text.split("\r\n")
        .nth(1)
        .unwrap_or(&text)
        .trim_end_matches('\u{fffd}')
        .to_string()
}

/// 単発のステータス取得（印字はしない）。
pub fn status(driver: &Sr3500p) -> Result<PrinterStatus, String> {
    let mut t = open(driver)?;
    query(driver, &mut t)
}

/// `copies` 枚ぶん、1 枚ごとに SOFT_RESET → 準備完了待ち → 送信 → 完了待ちを繰り返す。
pub fn send(
    driver: &Sr3500p,
    tape_mm: Option<u32>,
    bytes: &[u8],
    copies: u16,
) -> Result<(), String> {
    let mut t = open(driver)?;
    for n in 0..copies.max(1) {
        if copies > 1 {
            eprintln!("copy {}/{copies}", n + 1);
        }
        send_one(driver, &mut t, tape_mm, bytes)?;
    }
    Ok(())
}

/// 準備完了（エラーなし・テープあり・幅一致）を待ってから送り、完了まで状態を追う。
fn send_one(
    driver: &Sr3500p,
    t: &mut UsbTransport,
    tape_mm: Option<u32>,
    bytes: &[u8],
) -> Result<(), String> {
    prepare(t)?;

    let mut ready = false;
    for i in 0..240 {
        let st = query(driver, t);
        match &st {
            Ok(s) if s.error_code.is_none() && s.tape_width_mm.is_some() && !s.busy => {
                if let (Some(want), Some(have)) = (tape_mm, s.tape_width_mm)
                    && want != have
                {
                    return Err(format!(
                        "tape mismatch: job {want}mm, loaded {have}mm; nothing sent"
                    ));
                }
                eprintln!("ready: {}", describe(s));
                ready = true;
                break;
            }
            _ if i % 10 == 0 => eprintln!("waiting: {}", st.map_or_else(|e| e, |s| describe(&s))),
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if !ready {
        return Err("printer not ready; nothing sent".into());
    }

    t.write_all(bytes).map_err(|e| format!("write: {e}"))?;
    eprintln!("sent {} bytes", bytes.len());
    // 印字中（ST ≠ 0）を見てから待機に戻るまで待つ。印字が始まらないまま 8 秒経ったら終わる。
    let started = std::time::Instant::now();
    let mut last = String::new();
    let mut seen_busy = false;
    while started.elapsed() < Duration::from_secs(120) {
        if let Ok(s) = query(driver, t) {
            let line = describe(&s);
            if line != last {
                eprintln!("{:>5}ms {line}", started.elapsed().as_millis());
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
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("printer did not finish within 120 s".into())
}
