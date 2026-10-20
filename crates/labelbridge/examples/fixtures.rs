//! TS 版（packages/labelbridge）との突き合わせ用に、決まった模様のジョブを書き出す。
//!
//!   cargo run -p labelbridge --example fixtures -- packages/labelbridge/test/fixtures
//!
//! 模様はラベル画像の座標（x = 送り方向、y = テープ幅方向・上端 0）で定義し、
//! Rust のドライバ入力（行 = 送り方向）へは転置して渡す。TS 側も同じ式で画像を作る。

use labelbridge::{Cut, MonoBitmap, PrinterDriver, RasterJob, Sr3500p, Sr5900p, SrR2500p};

/// TS: packages/labelbridge/test/fixtures.test.ts の pattern() と同じ式。
fn pattern(width: u32, height: u32) -> MonoBitmap {
    let mut b = MonoBitmap::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let on = (x * 7 + y * 3) % 11 < 4 || (x < 3 && y < 5);
            b.set(x, y, on);
        }
    }
    b
}

fn job(dots: u32) -> RasterJob {
    RasterJob {
        tape_width_mm: 12,
        bitmap: pattern(50, dots).transpose(),
        copies: 1,
        cut: Cut::Full,
    }
}

/// オプションつき（濃度・余白・部数・カットなし）。既定値だけでは出ない差分を押さえる。
fn job_opts(dots: u32) -> RasterJob {
    RasterJob {
        copies: 2,
        cut: Cut::None,
        ..job(dots)
    }
}

fn flatten(p: &labelbridge::srr2500p::JobParts) -> Vec<u8> {
    let mut r = p.environment.clone();
    for _ in 0..p.copies {
        r.extend(&p.page_environment);
        p.bands.iter().for_each(|b| r.extend(b));
    }
    r.extend(&p.end);
    r
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "packages/labelbridge/test/fixtures".into());
    let write = |name: &str, bytes: &[u8]| {
        let path = format!("{dir}/{name}");
        std::fs::write(&path, bytes).unwrap();
        println!("wrote {path} ({} bytes)", bytes.len());
    };
    write(
        "sr3500p-12mm.bin",
        &Sr3500p::default().encode_job(&job(72)).unwrap(),
    );
    write(
        "sr5900p-12mm.bin",
        &Sr5900p::default().encode_job(&job(144)).unwrap(),
    );
    let p = SrR2500p::default().job_parts(&job(72)).unwrap();
    write("srr2500p-12mm.bin", &flatten(&p));

    let sr3500p = Sr3500p {
        density: 2,
        margin_dots: 10,
    };
    write(
        "sr3500p-12mm-opts.bin",
        &sr3500p.encode_job(&job_opts(72)).unwrap(),
    );
    let sr5900p = Sr5900p { density: -1 };
    write(
        "sr5900p-12mm-opts.bin",
        &sr5900p.encode_job(&job_opts(144)).unwrap(),
    );
    let srr2500p = SrR2500p {
        density: 3,
        margin_dots: 5,
    };
    let p = srr2500p.job_parts(&job_opts(72)).unwrap();
    write("srr2500p-12mm-opts.bin", &flatten(&p));
}
