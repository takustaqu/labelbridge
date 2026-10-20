//! ステータス要求 `ESC { I` / `ESC { Q`（印字・送りなし）を bulk OUT で送り、bulk IN の応答を表示する。
//!
//!   cargo run -p labelbridge-transport --features usb --example usb_status -- [I|Q] [flag]

use std::time::Duration;

use labelbridge_transport::Transport;
use labelbridge_transport::usb::{USB_VENDOR_ID, UsbTransport};

/// 引数で `I`（新世代）/ `Q`（第一世代）と自動通知フラグを選ぶ。
fn status_request(cmd: u8, a: u8) -> [u8; 8] {
    [0x1b, 0x7b, 0x05, cmd, a, 0x00, cmd.wrapping_add(a), 0x7d]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().map_or(b'Q', |s| s.as_bytes()[0]);
    let a: u8 = args.next().map_or(Ok(0), |s| s.parse())?;
    let pid = 0x0102;
    let request = status_request(cmd, a);
    let mut t = UsbTransport::open(USB_VENDOR_ID, pid)?;

    // 送信前に溜まっている応答があれば捨てる
    let mut buf = [0u8; 64];
    while let Ok(n) = t.read(&mut buf, Duration::from_millis(200)) {
        println!("pending: {}", hex(&buf[..n]));
    }

    t.write_all(&request)?;
    println!("sent: {}", hex(&request));
    let mut got = Vec::new();
    while let Ok(n) = t.read(&mut buf, Duration::from_millis(1000)) {
        got.extend_from_slice(&buf[..n]);
    }
    println!("recv ({} bytes): {}", got.len(), hex(&got));
    Ok(())
}

fn hex(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{x:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}
