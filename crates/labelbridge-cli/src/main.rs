//! labelbridge: ラベルプリンター（SR3500P / SR-R2500P / SR5900P）の CLI。
//!
//!   labelbridge area [--model M]
//!       機種ごと・テープ幅ごとの印字範囲（1 行の印字可能ドット数など）を表示する。
//!   labelbridge status --model M [--port P | --host H]
//!       装着テープと、そのテープでの印字可能ドット数を表示する（印字しない）。
//!   labelbridge print-image <image.png> --model M [--port P | --host H] [--tape MM]
//!       [--copies N] [--cut full|half|none] [--density N] [--threshold 0-255] [--dry-run out.bin]
//!       PNG を 1 画素 = 1 ドットで印刷する（拡大縮小しない）。
//!       画像の幅 = ラベル長（送り方向のドット数）、高さ = 印字可能ドット数以下（上詰め）。
//!   labelbridge testprint --model M [--port P | --host H] [--tape MM] [--length MM] [--dry-run out.bin]
//!       外枠・対角線・向きマーカーのテストパターンを印刷する。
//!
//! M: sr3500p（USB）/ sr-r2500p（Bluetooth。--port は機器名か /dev/...）/ sr5900p（LAN。--host が必要）
//!
//! ライブラリ（`labelbridge` クレート）の使い方の見本を兼ねる。

#[cfg(feature = "bt")]
mod bt;
mod net;
#[cfg(feature = "usb")]
mod usb;

use std::process::ExitCode;

use labelbridge::{
    Capabilities, Confidence, Cut, ModelId, MonoBitmap, PrinterDriver, PrinterStatus, RasterJob,
    Sr3500p, Sr5900p, SrR2500p, TransportKind, all_models, mm_to_dots, model, model_for_usb,
    models_for,
};

const USAGE: &str = "usage:
  labelbridge area [--model M]
  labelbridge status [--model M] [--port P | --host H]
  labelbridge print-image <image.png> [--model M] [--port P | --host H] [--tape MM] [--copies N]
              [--cut full|half|none] [--density N] [--margin DOTS] [--threshold T] [--dry-run out.bin]
  labelbridge testprint [--model M] [--port P | --host H] [--tape MM] [--length MM] [--dry-run out.bin]
  labelbridge --help

commands:
  area         機種ごと・テープ幅ごとの印字範囲（1 行の印字可能ドット数）を表示する
  status       装着テープと、そのテープでの印字可能ドット数を読む（印字しない）
  print-image  PNG を 1 画素 = 1 ドットで印刷する（拡大縮小しない）。
               画像の幅 = ラベル長、高さ = 印字可能ドット数以下（上詰め）
  testprint    外枠・対角線・向きマーカーのテストパターンを印刷する

options:
  --model M      sr3500p（USB）| sr-r2500p（Bluetooth）| sr5900p（LAN）。
                 省略時は --host なら LAN、--port なら Bluetooth、どちらもなければ USB 機器から決める
  --port P       sr-r2500p: Bluetooth の機器名か /dev/...（既定: 機器名で探す）
  --host H       sr5900p: プリンターの IP アドレスかホスト名（必須）
  --tape MM      テープ幅。省略時は実機から読む
  --copies N     枚数（既定 1）
  --cut MODE     full | half | none（既定 full。half は sr5900p のみ）
  --density N    濃度 -5..5（既定 0。sr5900p は未対応）
  --margin DOTS  ラベル前後の余白（ドット。sr3500p / sr-r2500p）
  --threshold T  二値化のしきい値 0-255（既定 128）
  --length MM    testprint のラベル長（既定 30）
  --dry-run F    送らずにジョブのバイト列を F に書く（--tape が必要）";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    if args.is_empty() || args.iter().any(|a| matches!(*a, "--help" | "-h" | "help")) {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let result = match args.as_slice() {
        ["area", rest @ ..] => Opts::parse(rest).and_then(|o| area(&o)),
        ["status", rest @ ..] => Opts::parse(rest).and_then(|o| status(&o)),
        ["print-image", rest @ ..] => Opts::parse(rest).and_then(|o| print_image(&o)),
        ["testprint", rest @ ..] => Opts::parse(rest).and_then(|o| testprint(&o)),
        [cmd, ..] => Err(format!("unknown command `{cmd}`\n{USAGE}")),
        [] => Err(USAGE.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Default)]
struct Opts {
    file: Option<String>,
    model: Option<ModelId>,
    port: Option<String>,
    host: Option<String>,
    tape: Option<u32>,
    copies: u16,
    cut: Option<Cut>,
    density: i8,
    margin_dots: u32,
    threshold: u8,
    length_mm: f64,
    dry_run: Option<String>,
}

impl Opts {
    fn parse(args: &[&str]) -> Result<Self, String> {
        let mut o = Opts {
            copies: 1,
            threshold: 128,
            length_mm: 30.0,
            ..Default::default()
        };
        let mut it = args.iter();
        while let Some(a) = it.next() {
            let mut val = || it.next().copied().ok_or(format!("{a} needs a value"));
            let num = |v: &str| v.parse::<f64>().map_err(|e| format!("{a}: {e}"));
            let int = |v: &str, lo: i64, hi: i64| {
                v.parse::<i64>()
                    .ok()
                    .filter(|n| (lo..=hi).contains(n))
                    .ok_or(format!(
                        "{a}: expected an integer in {lo}..={hi}, got `{v}`"
                    ))
            };
            match *a {
                "--model" => {
                    let v = val()?;
                    o.model =
                        Some(ModelId::parse(v).ok_or(format!("unknown model `{v}`\n{USAGE}"))?)
                }
                "--port" => o.port = Some(val()?.into()),
                "--host" => o.host = Some(val()?.into()),
                "--tape" => o.tape = Some(int(val()?, 1, 100)? as u32),
                "--copies" => o.copies = int(val()?, 1, 999)? as u16,
                "--density" => o.density = int(val()?, -5, 5)? as i8,
                "--margin" => o.margin_dots = int(val()?, 0, 10_000)? as u32,
                "--threshold" => o.threshold = int(val()?, 0, 255)? as u8,
                "--length" => o.length_mm = num(val()?)?,
                "--dry-run" => o.dry_run = Some(val()?.into()),
                "--cut" => {
                    o.cut = Some(match val()? {
                        "full" => Cut::Full,
                        "half" => Cut::Half,
                        "none" => Cut::None,
                        v => return Err(format!("--cut: {v}")),
                    })
                }
                s if s.starts_with("--") => return Err(format!("unknown option {s}\n{USAGE}")),
                s if o.file.is_none() => o.file = Some(s.into()),
                s => return Err(format!("unexpected argument {s}\n{USAGE}")),
            }
        }
        Ok(o)
    }

    /// `--model` がなければ、--host（LAN）/ --port（Bluetooth）/ つながっている USB 機器から機種を決める。
    fn model(&self) -> Result<ModelId, String> {
        if let Some(m) = self.model {
            return Ok(m);
        }
        let transport = if self.host.is_some() {
            TransportKind::Tcp
        } else if self.port.is_some() {
            TransportKind::Bluetooth
        } else {
            return usb_model();
        };
        let mut candidates = models_for(transport).map(|c| c.model);
        match (candidates.next(), candidates.next()) {
            (Some(m), None) => Ok(m),
            _ => Err(format!("--model is required\n{USAGE}")),
        }
    }
}

#[cfg(feature = "usb")]
fn usb_model() -> Result<ModelId, String> {
    let devices = labelbridge_transport::usb::list_supported_devices()
        .map_err(|e| format!("cannot list USB devices: {e}"))?;
    let mut found = devices
        .iter()
        .filter_map(|(vid, pid, _)| model_for_usb(*vid, *pid).map(|c| c.model));
    match (found.next(), found.next()) {
        (Some(m), None) => {
            eprintln!("using {} (found on USB)", model_name(m));
            Ok(m)
        }
        (Some(_), Some(_)) => Err(format!(
            "more than one supported USB printer; --model is required\n{USAGE}"
        )),
        (None, _) => Err(format!(
            "no supported USB printer found; --model is required\n{USAGE}"
        )),
    }
}
#[cfg(not(feature = "usb"))]
fn usb_model() -> Result<ModelId, String> {
    Err(format!("--model is required\n{USAGE}"))
}

fn model_name(m: ModelId) -> &'static str {
    model(m).display_name
}

// ---- area ----

fn area(o: &Opts) -> Result<(), String> {
    let models: Vec<&Capabilities> = match o.model {
        Some(m) => vec![model(m)],
        None => all_models().collect(),
    };
    println!(
        "{:<10} {:>5} {:>5} {:>8} {:>9}  confidence",
        "model", "tape", "dpi", "dots", "mm"
    );
    for c in models {
        for t in c.tapes {
            println!(
                "{:<10} {:>3}mm {:>5} {:>8} {:>9.2}  {:?}",
                c.display_name,
                t.width_mm,
                c.dpi,
                t.printable_dots,
                t.printable_dots as f64 * 25.4 / c.dpi as f64,
                t.confidence
            );
        }
    }
    Ok(())
}

// ---- status ----

fn read_status(o: &Opts, m: ModelId) -> Result<PrinterStatus, String> {
    match m {
        ModelId::Sr5900p => net::status(o.host.as_deref().ok_or("--host is required for sr5900p")?),
        ModelId::SrR2500p => bt_status(o.port.as_deref()),
        ModelId::Sr3500p => usb_status(),
    }
}

#[cfg(feature = "bt")]
fn bt_status(port: Option<&str>) -> Result<PrinterStatus, String> {
    bt::status(port.unwrap_or(bt::DEFAULT_DEVICE), &SrR2500p::default()).map_err(|e| e.to_string())
}
#[cfg(not(feature = "bt"))]
fn bt_status(_: Option<&str>) -> Result<PrinterStatus, String> {
    Err("built without Bluetooth support (feature `bt`)".into())
}
#[cfg(feature = "usb")]
fn usb_status() -> Result<PrinterStatus, String> {
    usb::status(&Sr3500p::default())
}
#[cfg(not(feature = "usb"))]
fn usb_status() -> Result<PrinterStatus, String> {
    Err("built without USB support (feature `usb`)".into())
}

fn status(o: &Opts) -> Result<(), String> {
    let m = o.model()?;
    let s = read_status(o, m)?;
    let caps = model(m);
    println!("model:    {}", caps.display_name);
    println!("busy:     {}", s.busy);
    println!(
        "error:    {}",
        s.error_code.map_or("none".into(), |e| format!("{e:#04x}"))
    );
    match s.tape_width_mm {
        Some(mm) => {
            println!("tape:     {mm}mm");
            match caps.tape(mm) {
                Some(t) => {
                    println!("dpi:      {}", caps.dpi);
                    println!(
                        "dots:     {} per line ({:.2}mm){}",
                        t.printable_dots,
                        t.printable_dots as f64 * 25.4 / caps.dpi as f64,
                        if t.confidence == Confidence::Verified {
                            ""
                        } else {
                            "  [not verified on hardware]"
                        }
                    );
                }
                None => println!(
                    "dots:     (this tape width is not supported by {})",
                    caps.display_name
                ),
            }
        }
        None => println!("tape:     none"),
    }
    Ok(())
}

// ---- print-image / testprint ----

/// 画像（x = 送り方向、y = テープ幅方向・上端 0）を、ドライバ入力（行 = 送り方向）に転置して印刷する。
fn print_label(o: &Opts, m: ModelId, label: MonoBitmap, tape_mm: u32) -> Result<(), String> {
    let job = RasterJob {
        tape_width_mm: tape_mm,
        bitmap: label.transpose(),
        copies: o.copies.max(1),
        cut: o.cut.unwrap_or(Cut::Full),
    };
    let sr3500p = Sr3500p {
        density: o.density,
        margin_dots: o.margin_dots,
    };
    let srr2500p = SrR2500p {
        density: o.density,
        margin_dots: o.margin_dots.min(u16::MAX as u32) as u16,
    };
    let sr5900p = Sr5900p { density: o.density };
    if m == ModelId::Sr5900p && o.margin_dots != 0 {
        eprintln!("warning: --margin is not supported for SR5900P yet; ignored");
    }
    let driver: &dyn PrinterDriver = match m {
        ModelId::Sr3500p => &sr3500p,
        ModelId::SrR2500p => &srr2500p,
        ModelId::Sr5900p => &sr5900p,
    };
    let bytes = driver.encode_job(&job).map_err(|e| e.to_string())?;
    eprintln!(
        "{}: {}mm tape, {} lines x {} dots, {} bytes",
        model_name(m),
        tape_mm,
        job.bitmap.height(),
        job.bitmap.width(),
        bytes.len()
    );
    if let Some(path) = &o.dry_run {
        std::fs::write(path, &bytes).map_err(|e| format!("{path}: {e}"))?;
        eprintln!("wrote {path} (not sent)");
        return Ok(());
    }
    match m {
        ModelId::Sr5900p => net::send(
            o.host.as_deref().ok_or("--host is required for sr5900p")?,
            &bytes,
            tape_mm,
        ),
        ModelId::SrR2500p => bt_send(o.port.as_deref(), &srr2500p, &job),
        ModelId::Sr3500p => usb_send(&sr3500p, tape_mm, &bytes, job.copies),
    }
}

#[cfg(feature = "bt")]
fn bt_send(port: Option<&str>, driver: &SrR2500p, job: &RasterJob) -> Result<(), String> {
    let parts = driver.job_parts(job).map_err(|e| e.to_string())?;
    bt::send(
        port.unwrap_or(bt::DEFAULT_DEVICE),
        driver,
        &parts,
        job.tape_width_mm,
    )
    .map_err(|e| e.to_string())
}
#[cfg(not(feature = "bt"))]
fn bt_send(_: Option<&str>, _: &SrR2500p, _: &RasterJob) -> Result<(), String> {
    Err("built without Bluetooth support (feature `bt`)".into())
}
#[cfg(feature = "usb")]
fn usb_send(driver: &Sr3500p, tape_mm: u32, bytes: &[u8], copies: u16) -> Result<(), String> {
    usb::send(driver, Some(tape_mm), bytes, copies)
}
#[cfg(not(feature = "usb"))]
fn usb_send(_: &Sr3500p, _: u32, _: &[u8], _: u16) -> Result<(), String> {
    Err("built without USB support (feature `usb`)".into())
}

/// テープ幅: --tape があればそれ、なければ実機から読む。
fn resolve_tape(o: &Opts, m: ModelId) -> Result<u32, String> {
    if let Some(t) = o.tape {
        return Ok(t);
    }
    if o.dry_run.is_some() {
        return Err("--tape is required with --dry-run".into());
    }
    let s = read_status(o, m)?;
    s.tape_width_mm.ok_or("no tape loaded".into())
}

fn printable_dots(m: ModelId, tape_mm: u32) -> Result<u32, String> {
    let caps = model(m);
    let t = caps.tape(tape_mm).ok_or(format!(
        "{} does not support {tape_mm}mm tape",
        caps.display_name
    ))?;
    if t.confidence != Confidence::Verified {
        eprintln!(
            "note: {} dots for {tape_mm}mm on {} is not verified on hardware",
            t.printable_dots, caps.display_name
        );
    }
    Ok(t.printable_dots)
}

fn print_image(o: &Opts) -> Result<(), String> {
    let m = o.model()?;
    let path = o
        .file
        .as_deref()
        .ok_or(format!("image file is required\n{USAGE}"))?;
    let (w, h, luma) = load_png(path)?;
    let tape = resolve_tape(o, m)?;
    let dots = printable_dots(m, tape)?;
    if h > dots {
        return Err(format!(
            "{path} is {h} px tall, but {}mm tape on {} prints {dots} dots per line (images are never scaled)",
            tape,
            model_name(m)
        ));
    }
    if h < dots {
        eprintln!("note: image is {h} px tall; placed at the top of the {dots}-dot printable area");
    }
    let mut label = MonoBitmap::new(w, dots);
    // load_png が w * h <= usize::MAX と luma.len() == w * h を保証している
    for (y, row) in luma.chunks_exact(w as usize).enumerate() {
        for (x, &v) in row.iter().enumerate() {
            if v < o.threshold {
                label.set(x as u32, y as u32, true);
            }
        }
    }
    print_label(o, m, label, tape)
}

/// 画像の幅（= 送り方向のライン数）の上限。これより長いラベルはどの機種でも扱えない。
const MAX_IMAGE_WIDTH: u32 = 1 << 20;

/// 幅・高さを検査し、画素数を返す。
fn check_image_size(path: &str, w: u32, h: u32) -> Result<usize, String> {
    if w == 0 || h == 0 {
        return Err(format!("{path}: image is empty ({w} x {h})"));
    }
    if w > MAX_IMAGE_WIDTH {
        return Err(format!(
            "{path}: image is {w} px wide; at most {MAX_IMAGE_WIDTH} px (lines) are supported"
        ));
    }
    (w as usize)
        .checked_mul(h as usize)
        .ok_or_else(|| format!("{path}: image is too large ({w} x {h})"))
}

/// PNG を読み、透明を白として輝度（0 = 黒）にする。
fn load_png(path: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut dec = png::Decoder::new(std::io::BufReader::new(file));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().map_err(|e| format!("{path}: {e}"))?;
    let (iw, ih) = (reader.info().width, reader.info().height);
    check_image_size(path, iw, ih)?;
    let mut buf = vec![0; reader.output_buffer_size().ok_or("image too large")?];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("{path}: {e}"))?;
    let (w, h) = (info.width, info.height);
    let pixels = check_image_size(path, w, h)?;
    let ch = info.color_type.samples();
    let mut luma = Vec::with_capacity(pixels);
    for px in buf[..info.buffer_size()].chunks(ch) {
        let (y, a) = match px {
            [g] => (*g as f32, 255.0),
            [g, a] => (*g as f32, *a as f32),
            [r, g, b] => (
                0.299 * *r as f32 + 0.587 * *g as f32 + 0.114 * *b as f32,
                255.0,
            ),
            [r, g, b, a] => (
                0.299 * *r as f32 + 0.587 * *g as f32 + 0.114 * *b as f32,
                *a as f32,
            ),
            _ => return Err(format!("{path}: unsupported pixel format")),
        };
        luma.push(if a < 128.0 { 255 } else { y as u8 });
    }
    if luma.len() != pixels {
        return Err(format!("{path}: unexpected pixel data size"));
    }
    Ok((w, h, luma))
}

/// 外周 2 ドットの枠、dot 0（上端）側のマーカー、対角線、20 行ごとに伸びる横棒。
/// 幅・高さとも 4 ドット以上が要る。
fn pattern(width: u32, height: u32) -> Result<MonoBitmap, String> {
    if width < 4 || height < 4 {
        return Err(format!(
            "test pattern needs at least 4 x 4 dots, got {width} x {height}"
        ));
    }
    let mut b = MonoBitmap::new(width, height);
    b.fill_rect(0, 0, width, 2);
    b.fill_rect(0, height - 2, width, 2);
    b.fill_rect(0, 0, 2, height);
    b.fill_rect(width - 2, 0, 2, height);
    b.fill_rect(8, 0, 24, 8);
    for x in 0..width {
        let y = x * (height - 1) / (width - 1);
        b.fill_rect(x, y.saturating_sub(1), 1, 2);
    }
    for (i, x) in (40..width.saturating_sub(10)).step_by(20).enumerate() {
        b.fill_rect(x, 0, 3, ((i as u32 + 1) * 8).min(height));
    }
    Ok(b)
}

fn testprint(o: &Opts) -> Result<(), String> {
    let m = o.model()?;
    let tape = resolve_tape(o, m)?;
    let dots = printable_dots(m, tape)?;
    let width = mm_to_dots(o.length_mm, model(m).dpi);
    print_label(o, m, pattern(width, dots)?, tape)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_has_border_and_top_marker() {
        let p = pattern(100, 72).unwrap();
        assert!(p.get(0, 0) && p.get(99, 71) && p.get(50, 0) && p.get(0, 40));
        assert!(p.get(10, 4)); // 上端側のマーカー
        assert!(!p.get(10, 60));
        assert!(pattern(2, 72).is_err() && pattern(100, 3).is_err());
    }

    #[test]
    fn image_size_limits() {
        assert_eq!(check_image_size("a.png", 10, 7), Ok(70));
        let wide = check_image_size("a.png", MAX_IMAGE_WIDTH + 1, 1).unwrap_err();
        assert!(wide.contains("at most"), "{wide}");
        assert!(check_image_size("a.png", 0, 5).is_err());
        assert_eq!(
            check_image_size("a.png", MAX_IMAGE_WIDTH, u32::MAX),
            (MAX_IMAGE_WIDTH as usize)
                .checked_mul(u32::MAX as usize)
                .ok_or_else(|| format!(
                    "a.png: image is too large ({MAX_IMAGE_WIDTH} x {})",
                    u32::MAX
                ))
        );
    }

    #[test]
    fn options_parse() {
        let o = Opts::parse(&[
            "a.png",
            "--model",
            "SR-R2500P",
            "--tape",
            "12",
            "--cut",
            "half",
        ])
        .unwrap();
        assert_eq!(o.file.as_deref(), Some("a.png"));
        assert_eq!(o.model, Some(ModelId::SrR2500p));
        assert_eq!(o.tape, Some(12));
        assert_eq!(o.cut, Some(Cut::Half));
        assert!(Opts::parse(&["--model", "x"]).is_err());
    }
}
