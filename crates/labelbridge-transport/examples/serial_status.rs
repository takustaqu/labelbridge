//! シリアル（Bluetooth SPP）の機器に制御コマンドを順に送り、応答を表示する。印字や送りはしない。
//!
//!   cargo run -p labelbridge-transport --features serial --example serial_status -- /dev/cu.SR-R2500P [once|auto|reset|wait:MS]...
//!
//! 既定のシーケンスは `once`（ESC { I 00 00 }）。

use std::time::Duration;

use labelbridge_transport::Transport;
use labelbridge_transport::serial::SerialTransport;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| "/dev/cu.SR-R2500P".into());
    let mut steps: Vec<String> = args.collect();
    if steps.is_empty() {
        steps.push("once".into());
    }
    let started = std::time::Instant::now();
    let mut t = SerialTransport::open(&path)?;
    println!("opened {path} in {} ms", started.elapsed().as_millis());
    drain(&mut t, 300, "pending");

    for step in steps {
        let cmd: &[u8] = match step.as_str() {
            "once" => &[0x1b, 0x7b, 0x05, 0x49, 0x00, 0x00, 0x49, 0x7d],
            "auto" => &[0x1b, 0x7b, 0x05, 0x49, 0x05, 0x00, 0x4e, 0x7d],
            "reset" => &[0x1b, 0x7b, 0x03, 0x21, 0x21, 0x7d],
            s if s.starts_with("wait:") => {
                std::thread::sleep(Duration::from_millis(s[5..].parse()?));
                continue;
            }
            other => return Err(format!("unknown step {other}").into()),
        };
        t.write_all(cmd)?;
        println!(
            "{:>6}ms sent {step}: {}",
            started.elapsed().as_millis(),
            hex(cmd)
        );
        drain(&mut t, 2500, "recv");
    }
    Ok(())
}

fn drain(t: &mut SerialTransport, ms: u64, label: &str) {
    let mut buf = [0u8; 1024];
    let mut got = Vec::new();
    while let Ok(n) = t.read(&mut buf, Duration::from_millis(ms)) {
        got.extend_from_slice(&buf[..n]);
    }
    if !got.is_empty() {
        let ascii: String = got
            .iter()
            .map(|&b| {
                if (0x20..0x7f).contains(&b) {
                    b as char
                } else {
                    '.'
                }
            })
            .collect();
        println!(
            "  {label} ({} bytes): {}",
            got.len(),
            &ascii[..ascii.len().min(40)]
        );
        let frames = got.windows(8).filter(|w| w == b"@BDC ST2").count();
        if frames > 0 {
            println!(
                "  frames: {frames}, first body ST/ER/TW: {}",
                hex(&got[13..16.min(got.len())])
            );
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{x:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}
