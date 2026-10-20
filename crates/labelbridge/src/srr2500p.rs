//! SR-R2500P（Bluetooth Classic SPP）。commandLevel 5 の手順に従う（docs/protocol.md §3）。
//!
//! ```text
//! ESC { I 05 00 }           ステータス自動通知 ON → ステータスを待つ
//! @ / {ST / C / D / G       ジョブ環境
//! ESC { I 05 00 }           → ステータスを待つ
//! ページごと:
//!   L <行数> / T <余白>
//!   (ESC . 00 00 00 01 nL nH <data>) × 行数（1024 行ごとにステータス確認）
//!   FF
//! @                         印刷終了 → ステータスを待つ
//! ESC { I 00 00 }           自動通知 OFF（これを省くと次の接続でステータスが取れない）
//! ```
//!
//! ステータスは 92 バイト: `@BDC ST2\r\nP\0;`（13 バイト）+ 本体 78 バイト + 1 バイト。
//! 本体の [1] = ST、[2] = ER、[3] = TW。
//!
//! `ESC { ! }`（リセット）は送らない: macOS では Bluetooth のリンクが切れ、再接続できなくなる（実機確認）。

use crate::{
    Capabilities, Cut, DriverError, ModelId, PrinterDriver, PrinterStatus, RasterJob, cmd, model,
    tape_code_to_mm,
};

pub const STATUS_ONCE: [u8; 8] = [0x1b, 0x7b, 0x05, 0x49, 0x00, 0x00, 0x49, 0x7d];
pub const STATUS_AUTO: [u8; 8] = [0x1b, 0x7b, 0x05, 0x49, 0x05, 0x00, 0x4e, 0x7d];
pub const STATUS_LEN: usize = 92;
const STATUS_PREFIX: &[u8] = b"@BDC ST2";
/// 1 回に送る行数（PrintController.PRINT_CONTROLLER_BANDING_SIZE）。
pub const BAND_LINES: usize = 1024;

#[derive(Debug, Clone, Default)]
pub struct SrR2500p {
    /// 濃度 -5..=5（`D` = density + 5）。
    pub density: i8,
    /// ページ先頭の余白（ドット、`T`）。
    pub margin_dots: u16,
}

/// 対話的に送るためのジョブの部品。
#[derive(Debug, Clone)]
pub struct JobParts {
    pub environment: Vec<u8>,
    /// 部数ぶん繰り返す: ページ環境 → bands → FF
    pub page_environment: Vec<u8>,
    pub bands: Vec<Vec<u8>>,
    pub copies: u16,
    pub end: Vec<u8>,
}

impl SrR2500p {
    pub fn job_parts(&self, job: &RasterJob) -> Result<JobParts, DriverError> {
        self.check_job(job, None)?;
        let tape = self
            .capabilities()
            .tape(job.tape_width_mm)
            .expect("checked");
        let dots = tape.printable_dots as u16;
        let width = job.bitmap.width();

        // C: カット値（ハーフカットなし機種。Half は check_job で拒む）
        let cut: [u8; 4] = match job.cut {
            Cut::Full | Cut::Half => [0x01, 0x01, 0x01, 0x01],
            Cut::None => [0x00, 0x00, 0x00, 0x00],
        };
        let mut environment = cmd::job_boundary();
        environment.extend(cmd::start_job());
        environment.extend(cmd::frame(b'C', &cut));
        environment.extend(cmd::density(self.density));
        environment.extend(cmd::g());

        let lines = job.bitmap.height();
        let mut page_environment = cmd::length(lines);
        page_environment.extend(cmd::leading(self.margin_dots));

        // 1 行の中は dot 0 がラベル下端。MonoBitmap は dot 0 = 上端なので、
        // 印字可能ドット数を基準に反転して詰める（画像が狭いときも上詰めになる）。
        let mut bands = Vec::new();
        let mut band = Vec::new();
        let row_bytes = (dots as usize).div_ceil(8);
        let mut row = vec![0u8; row_bytes];
        for y in 0..lines {
            row.fill(0);
            for x in 0..width {
                if job.bitmap.get(x, y) {
                    let d = u32::from(dots) - 1 - x;
                    row[d as usize / 8] |= 0x80 >> (d % 8);
                }
            }
            cmd::raster_line(&mut band, 0x00, dots, &row);
            if (y as usize + 1) % BAND_LINES == 0 {
                bands.push(std::mem::take(&mut band));
            }
        }
        if !band.is_empty() {
            bands.push(band);
        }

        Ok(JobParts {
            environment,
            page_environment,
            bands,
            copies: job.copies.max(1),
            end: cmd::job_boundary(),
        })
    }
}

impl PrinterDriver for SrR2500p {
    fn capabilities(&self) -> &Capabilities {
        model(ModelId::SrR2500p)
    }

    fn status_request(&self) -> Result<Vec<u8>, DriverError> {
        Ok(STATUS_ONCE.to_vec())
    }

    fn parse_status(&self, b: &[u8]) -> Result<PrinterStatus, DriverError> {
        let start = b
            .windows(STATUS_PREFIX.len())
            .position(|w| w == STATUS_PREFIX)
            .ok_or(DriverError::BadStatus(b.len()))?;
        let frame = b
            .get(start..start + STATUS_LEN)
            .ok_or(DriverError::BadStatus(b.len()))?;
        let body = &frame[13..13 + 78];
        let (st, er, tw) = (body[1], body[2], body[3]);
        Ok(PrinterStatus {
            tape_width_mm: tape_code_to_mm(tw),
            busy: st != 0x00,
            state: st,
            no_tape: matches!(er, 0x06 | 0x42),
            cover_open: er == 0x21,
            error_code: (er != 0).then_some(er),
            raw: frame.to_vec(),
        })
    }

    /// dry-run 用に、対話手順で送るバイト列を連結して返す（ステータス待ちは含まない）。
    fn encode_job(&self, job: &RasterJob) -> Result<Vec<u8>, DriverError> {
        let p = self.job_parts(job)?;
        let mut out = STATUS_AUTO.to_vec();
        out.extend(&p.environment);
        out.extend(STATUS_AUTO);
        for _ in 0..p.copies {
            out.extend(&p.page_environment);
            p.bands.iter().for_each(|b| out.extend(b));
            out.push(cmd::FORM_FEED);
        }
        out.extend(&p.end);
        out.extend(STATUS_ONCE);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bitmap::MonoBitmap;

    #[test]
    fn parses_captured_status() {
        // SR-R2500P 実機（12mm テープ、待機中）の応答
        let mut frame = vec![
            0x40, 0x42, 0x44, 0x43, 0x20, 0x53, 0x54, 0x32, 0x0d, 0x0a, 0x50, 0x00, 0x3b, 0x4e,
            0x00, 0x00, 0x03,
        ];
        frame.resize(91, 0);
        frame.push(0x8c);
        let s = SrR2500p::default().parse_status(&frame).unwrap();
        assert_eq!(s.tape_width_mm, Some(12));
        assert!(!s.busy && s.error_code.is_none());

        frame[13 + 2] = 0x21;
        assert!(SrR2500p::default().parse_status(&frame).unwrap().cover_open);
        assert!(SrR2500p::default().parse_status(&frame[..50]).is_err());
    }

    #[test]
    fn raster_rows_put_the_top_of_the_label_at_the_last_dot() {
        let mut bm = MonoBitmap::new(72, 2);
        bm.set(0, 0, true); // 1 行目・ラベル上端
        let job = RasterJob {
            tape_width_mm: 12,
            bitmap: bm,
            copies: 1,
            cut: Cut::Full,
        };
        let p = SrR2500p::default().job_parts(&job).unwrap();
        assert_eq!(p.bands.len(), 1);
        let line = 8 + 9;
        assert_eq!(p.bands[0].len(), 2 * line);
        assert_eq!(
            p.bands[0][..8],
            [0x1b, 0x2e, 0x00, 0x00, 0x00, 0x01, 72, 0x00]
        );
        assert_eq!(p.bands[0][8 + 8], 0x01); // dot 71 = 上端
        assert!(p.bands[0][line + 8..].iter().all(|&b| b == 0));
        assert_eq!(p.environment[..6], cmd::job_boundary()[..]);
        assert_eq!(
            p.page_environment,
            [cmd::length(2), cmd::leading(0)].concat()
        );
    }

    #[test]
    fn narrow_images_stay_at_the_top_of_the_printable_area() {
        // 高さ 10 ドットの画像でも、1 行目はラベル上端（dot 71）に来る
        let mut bm = MonoBitmap::new(10, 1);
        bm.set(0, 0, true);
        let job = RasterJob {
            tape_width_mm: 12,
            bitmap: bm,
            copies: 1,
            cut: Cut::Full,
        };
        let p = SrR2500p::default().job_parts(&job).unwrap();
        assert_eq!(p.bands[0][8 + 8], 0x01);
    }
}
