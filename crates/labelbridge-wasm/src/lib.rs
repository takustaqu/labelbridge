//! labelbridge を wasm にして、TS（packages/labelbridge/src/core/wasm.ts）から呼ぶための入り口。
//!
//! wasm-bindgen は使わず、素の関数だけを出す:
//!
//! - `lb_alloc(n)` / `lb_free(p, n)`: 入力を置くメモリ
//! - `lb_call(req, req_len, data, data_len)`: 要求（JSON）と付属のバイト列を渡す。0 = 成功、1 = 失敗
//! - `lb_out_ptr()` / `lb_out_len()`: 結果。`[u32 JSON の長さ][JSON][u32 個数]([u32 長さ][バイト列])*`（LE）
//!
//! 失敗のときの JSON は `{"error": 種類, …}`。TS 側がメッセージにする。

use std::cell::RefCell;

use labelbridge::sr5900p::{Calibration, layout};
use labelbridge::{
    Cut, DriverError, ModelId, MonoBitmap, PrinterDriver, PrinterStatus, RasterJob, Sr3500p,
    Sr5900p, SrR2500p, TransportKind, all_models, find_status, tape_code_to_mm,
};
use serde::Deserialize;
use serde_json::{Value, json};

/// 呼び出しの結果: JSON とバイト列（JSON からは番号で指す）
#[derive(Default)]
pub struct Reply {
    pub json: Value,
    pub blobs: Vec<Vec<u8>>,
}

impl Reply {
    fn blob(&mut self, b: Vec<u8>) -> usize {
        self.blobs.push(b);
        self.blobs.len() - 1
    }

    fn encode(&self) -> Vec<u8> {
        let j = serde_json::to_vec(&self.json).unwrap_or_default();
        let mut out =
            Vec::with_capacity(8 + j.len() + self.blobs.iter().map(|b| b.len() + 4).sum::<usize>());
        out.extend((j.len() as u32).to_le_bytes());
        out.extend(j);
        out.extend((self.blobs.len() as u32).to_le_bytes());
        for b in &self.blobs {
            out.extend((b.len() as u32).to_le_bytes());
            out.extend(b);
        }
        out
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Req {
    Models,
    TapeCodeToMm {
        code: u8,
    },
    #[serde(rename_all = "camelCase")]
    Encode {
        model: String,
        job: Job,
        images: Vec<Size>,
    },
    #[serde(rename_all = "camelCase")]
    Layout {
        count: usize,
        cut: String,
        margin_dots: Option<u32>,
        calibration: Option<Cal>,
    },
    FindStatus {
        model: String,
    },
}

#[derive(Deserialize)]
struct Size {
    width: u32,
    height: u32,
}

/// TS の `LabelJob` と機種ごとの設定（数値は TS 側で整数に丸めて渡す）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    tape_mm: u32,
    cut: Option<String>,
    copies: Option<u16>,
    density: Option<i8>,
    margin_dots: Option<u32>,
    leading_cut: Option<String>,
    calibration: Option<Cal>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Cal {
    head_gap_dots: Option<i32>,
    lead_adjust_dots: Option<i32>,
    tail_adjust_dots: Option<i32>,
    first_tail_adjust_dots: Option<i32>,
}

impl Cal {
    fn resolve(self) -> Calibration {
        let d = Calibration::default();
        Calibration {
            head_gap_dots: self.head_gap_dots.unwrap_or(d.head_gap_dots),
            lead_adjust_dots: self.lead_adjust_dots.unwrap_or(d.lead_adjust_dots),
            tail_adjust_dots: self.tail_adjust_dots.unwrap_or(d.tail_adjust_dots),
            first_tail_adjust_dots: self
                .first_tail_adjust_dots
                .unwrap_or(d.first_tail_adjust_dots),
        }
    }
}

/// 失敗の JSON
fn fail(kind: &str, extra: Value) -> Value {
    let mut v = json!({ "error": kind });
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
        o.extend(e);
    }
    v
}

fn driver_error(e: DriverError) -> Value {
    match e {
        DriverError::UnsupportedTape(mm) => fail("unsupportedTape", json!({ "tapeMm": mm })),
        DriverError::BitmapTooWide { got, max } => {
            fail("tooWide", json!({ "got": got, "max": max }))
        }
        DriverError::UnsupportedCut(c) => fail("unsupportedCut", json!({ "cut": cut_name(c) })),
        DriverError::TooLong(lines, max) => fail("tooLong", json!({ "lines": lines, "max": max })),
        DriverError::NoLabels => fail("noLabels", json!({})),
        e => fail("driver", json!({ "message": e.to_string() })),
    }
}

fn cut_name(c: Cut) -> &'static str {
    match c {
        Cut::Full => "full",
        Cut::Half => "half",
        Cut::None => "none",
    }
}

fn parse_cut(s: Option<&str>) -> Result<Cut, Value> {
    match s.unwrap_or("full") {
        "full" => Ok(Cut::Full),
        "half" => Ok(Cut::Half),
        "none" => Ok(Cut::None),
        other => Err(fail(
            "badRequest",
            json!({ "message": format!("cut: {other}") }),
        )),
    }
}

fn parse_model(s: &str) -> Result<ModelId, Value> {
    ModelId::parse(s).ok_or_else(|| fail("unknownModel", json!({ "model": s })))
}

fn status_json(s: &PrinterStatus) -> Value {
    json!({ "state": s.state, "error": s.error_code.unwrap_or(0), "tapeMm": s.tape_width_mm })
}

fn models() -> Value {
    let list: Vec<Value> = all_models()
        .map(|m| {
            let usb = match (m.usb_vendor_id, m.usb_product_id) {
                (Some(v), Some(p)) => json!({ "vendorId": v, "productId": p }),
                _ => Value::Null,
            };
            let connections: Vec<&str> = m
                .transports
                .iter()
                .map(|t| match t {
                    TransportKind::Usb => "usb",
                    TransportKind::Tcp => "lan",
                    TransportKind::Bluetooth => "bluetooth",
                })
                .collect();
            let tapes: Vec<Value> = m
                .tapes
                .iter()
                .map(|t| {
                    json!({
                        "widthMm": t.width_mm,
                        "printableDots": t.printable_dots,
                        "verified": t.confidence == labelbridge::Confidence::Verified,
                    })
                })
                .collect();
            json!({
                "id": m.display_name,
                "dpi": m.dpi,
                "headDots": m.head_dots,
                "tapes": tapes,
                "connections": connections,
                "fullCut": m.full_cut,
                "halfCut": m.half_cut,
                "usb": usb,
            })
        })
        .collect();
    Value::Array(list)
}

/// ラベル画像（x = 送り方向、y = テープ幅方向、1 画素 1 バイト）をドライバ入力の向きにする
fn bitmaps(images: &[Size], data: &[u8]) -> Result<Vec<MonoBitmap>, Value> {
    let mut at = 0usize;
    images
        .iter()
        .map(|s| {
            let n = s.width as usize * s.height as usize;
            let px = data
                .get(at..at + n)
                .ok_or_else(|| fail("badRequest", json!({ "message": "image data is short" })))?;
            at += n;
            let mut b = MonoBitmap::try_new(s.height, s.width)
                .map_err(|e| fail("badRequest", json!({ "message": e.to_string() })))?;
            for (i, &p) in px.iter().enumerate() {
                if p != 0 {
                    let (x, y) = ((i % s.width as usize) as u32, (i / s.width as usize) as u32);
                    b.set(y, x, true);
                }
            }
            Ok(b)
        })
        .collect()
}

fn encode(model: &str, job: Job, images: &[Size], data: &[u8], r: &mut Reply) -> Result<(), Value> {
    let id = parse_model(model)?;
    let cut = parse_cut(job.cut.as_deref())?;
    let bitmaps = bitmaps(images, data)?;
    let jobs: Vec<RasterJob> = bitmaps
        .into_iter()
        .map(|bitmap| RasterJob {
            tape_width_mm: job.tape_mm,
            bitmap,
            copies: job.copies.unwrap_or(1).max(1),
            cut,
        })
        .collect();
    let first = jobs
        .first()
        .ok_or_else(|| driver_error(DriverError::NoLabels))?;
    let density = job.density.unwrap_or(0);
    match id {
        ModelId::Sr3500p => {
            let d = Sr3500p {
                density,
                margin_dots: job.margin_dots.unwrap_or(0),
            };
            let b = d.encode_job(first).map_err(driver_error)?;
            let i = r.blob(b);
            r.json = json!({ "bytes": i });
        }
        ModelId::Sr5900p => {
            let d = Sr5900p {
                density,
                margin_dots: job.margin_dots,
                calibration: job.calibration.unwrap_or_default().resolve(),
                leading_half_cut: job.leading_cut.as_deref() == Some("half"),
            };
            for j in &jobs {
                d.check_job(j, None).map_err(driver_error)?;
            }
            let refs: Vec<&MonoBitmap> = jobs.iter().map(|j| &j.bitmap).collect();
            let b = d
                .encode_pages(&refs, job.tape_mm, cut, first.copies)
                .map_err(driver_error)?;
            let i = r.blob(b);
            r.json = json!({ "bytes": i });
        }
        ModelId::SrR2500p => {
            let d = SrR2500p {
                density,
                margin_dots: job.margin_dots.unwrap_or(0).min(u16::MAX.into()) as u16,
                keep_leading_blank: job.leading_cut.as_deref() == Some("none"),
            };
            let p = d.job_parts_pages(&jobs).map_err(driver_error)?;
            let environment = r.blob(p.environment);
            let end = r.blob(p.end);
            let pages: Vec<Value> = p
                .pages
                .into_iter()
                .map(|page| {
                    let env = r.blob(page.page_environment);
                    let bands: Vec<usize> = page.bands.into_iter().map(|b| r.blob(b)).collect();
                    json!({ "pageEnvironment": env, "bands": bands })
                })
                .collect();
            r.json = json!({ "environment": environment, "pages": pages, "copies": p.copies, "end": end });
        }
    }
    Ok(())
}

/// 1 回の呼び出し（テストからも使う）
pub fn call(req: &[u8], data: &[u8]) -> Result<Reply, Reply> {
    let mut r = Reply::default();
    let req: Req = match serde_json::from_slice(req) {
        Ok(q) => q,
        Err(e) => {
            return Err(Reply {
                json: fail("badRequest", json!({ "message": e.to_string() })),
                blobs: vec![],
            });
        }
    };
    let res = match req {
        Req::Models => {
            r.json = models();
            Ok(())
        }
        Req::TapeCodeToMm { code } => {
            r.json = json!(tape_code_to_mm(code));
            Ok(())
        }
        Req::Encode { model, job, images } => encode(&model, job, &images, data, &mut r),
        Req::Layout { count, cut, margin_dots, calibration } => parse_cut(Some(&cut)).map(|cut| {
            let (dummy, pads) = layout(count, cut, margin_dots, calibration.unwrap_or_default().resolve());
            r.json = json!({ "dummy": dummy, "pads": pads.iter().map(|(a, b)| [a, b]).collect::<Vec<_>>() });
        }),
        Req::FindStatus { model } => parse_model(&model).map(|id| {
            r.json = match find_status(id, data) {
                Some((s, start, end)) => json!({ "status": status_json(&s), "start": start, "end": end }),
                None => Value::Null,
            };
        }),
    };
    match res {
        Ok(()) => Ok(r),
        Err(json) => Err(Reply {
            json,
            blobs: vec![],
        }),
    }
}

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// 入力を置くメモリを n バイト確保する
#[unsafe(no_mangle)]
pub extern "C" fn lb_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// `lb_alloc` で確保したメモリを返す
///
/// # Safety
/// `p` と `n` は `lb_alloc(n)` が返したものであること
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lb_free(p: *mut u8, n: usize) {
    drop(unsafe { Vec::from_raw_parts(p, 0, n.max(1)) });
}

/// # Safety
/// `req` / `data` はそれぞれ `req_len` / `data_len` バイト読めること（`data_len` が 0 なら `data` は見ない）
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lb_call(
    req: *const u8,
    req_len: usize,
    data: *const u8,
    data_len: usize,
) -> u32 {
    let req = unsafe { std::slice::from_raw_parts(req, req_len) };
    let data = if data_len == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(data, data_len) }
    };
    let (code, reply) = match call(req, data) {
        Ok(r) => (0, r),
        Err(r) => (1, r),
    };
    OUT.with(|o| *o.borrow_mut() = reply.encode());
    code
}

#[unsafe(no_mangle)]
pub extern "C" fn lb_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn lb_out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_models() {
        let r = call(br#"{"op":"models"}"#, &[]).ok().unwrap();
        let ids: Vec<&str> = r
            .json
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["SR3500P", "SR5900P", "SR-R2500P"]);
    }

    #[test]
    fn reports_driver_errors() {
        let req = br#"{"op":"encode","model":"SR3500P","job":{"tapeMm":12,"cut":"half"},"images":[{"width":2,"height":72}]}"#;
        let e = call(req, &[0; 144]).err().unwrap();
        assert_eq!(e.json["error"], "unsupportedCut");
        let req = br#"{"op":"encode","model":"SR3500P","job":{"tapeMm":12},"images":[{"width":1,"height":73}]}"#;
        assert_eq!(call(req, &[0; 73]).err().unwrap().json["error"], "tooWide");
    }
}
