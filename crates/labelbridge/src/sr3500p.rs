//! SR3500P（USB）。ESC/P2 の ESC ( G / ESC ( v / ESC . で送る
//! （docs/protocol.md §2。実機での印字・カットを確認済み）。
//!
//! ```text
//! ESC { D <濃度+5> }                      濃度 0 以外のときだけ
//! ESC ( G 01 00 01                       グラフィックスモード
//! ESC ( C 02 00 <ページ長>
//! ESC ( v 02 00 <余白>                    余白 0 のときは省く
//! (ESC ( v 02 00 01 00 + ESC . 00 14 14 01 nL nH <data>) × 行数
//! FF
//! ESC @
//! ```
//!
//! - ジョブの前に USB プリンタークラスの SOFT_RESET が要る（省くと 2 回目以降のジョブが無視される）。
//! - カットはジョブ終了（`ESC @`）でしか起きず、FF で区切った 2 ページ目はつながって出る。
//!   `ESC @` の後のデータは SOFT_RESET を挟むまで無視されるので、1 ジョブ = 1 枚とし、
//!   `copies` は送信側が「SOFT_RESET → ジョブ」を繰り返して扱う（[`encode_job`] は copies を見ない）。
//!
//! [`encode_job`]: PrinterDriver::encode_job
//!
//! 行はラベルの末尾から送る（先頭から送ると左右が鏡像になる。実機確認）。
//!
//! ステータスは `ESC { Q` に対する 64 バイトのテキスト（`@BDC ST\r\nST:00;ER:00;…;` + 0xFF）。

use crate::{
    Capabilities, DriverError, ModelId, PrinterDriver, PrinterStatus, RasterJob, cmd, model,
    tape_code_to_mm,
};

/// `ESC { Q 00 00`: 単発のステータス要求。
pub const STATUS_REQUEST: [u8; 8] = [0x1b, 0x7b, 0x05, 0x51, 0x00, 0x00, 0x51, 0x7d];
/// `ESC { Q 05 00`: ステータス自動通知（印刷モード）。
pub const STATUS_AUTO: [u8; 8] = [0x1b, 0x7b, 0x05, 0x51, 0x05, 0x00, 0x56, 0x7d];

/// テキスト形式ステータスの 1 フレーム長。
pub const STATUS_LEN: usize = 64;

#[derive(Debug, Clone, Default)]
pub struct Sr3500p {
    /// 濃度 -5..=5（`D` = density + 5、0 が標準）。
    pub density: i8,
    /// 印字前後に足す空白（ドット）。ページ長に含め、先頭は `ESC ( v` で送る。
    pub margin_dots: u32,
}

impl PrinterDriver for Sr3500p {
    fn capabilities(&self) -> &Capabilities {
        model(ModelId::Sr3500p)
    }

    fn status_request(&self) -> Result<Vec<u8>, DriverError> {
        Ok(STATUS_REQUEST.to_vec())
    }

    /// `@BDC ST\r\nST:00;ER:00;WR:00;RV:00;TW:03;TR:00;CT:03;OP:00;EI:00;` + 0xFF。値は 16 進。
    fn parse_status(&self, b: &[u8]) -> Result<PrinterStatus, DriverError> {
        let start = b
            .windows(7)
            .position(|w| w == b"@BDC ST")
            .ok_or(DriverError::BadStatus(b.len()))?;
        let frame = b
            .get(start..start + STATUS_LEN)
            .ok_or(DriverError::BadStatus(b.len()))?;
        let text = String::from_utf8_lossy(frame);
        let field = |key: &str| {
            let at = text.find(&format!("{key}:"))? + key.len() + 1;
            u8::from_str_radix(text.get(at..at + 2)?, 16).ok()
        };
        let err = field("ER").ok_or(DriverError::BadStatus(b.len()))?;
        let st = field("ST").ok_or(DriverError::BadStatus(b.len()))?;
        Ok(PrinterStatus {
            tape_width_mm: field("TW").and_then(tape_code_to_mm),
            busy: st != 0x00,
            state: st,
            no_tape: matches!(err, 0x06 | 0x42),
            cover_open: err == 0x21,
            error_code: (err != 0).then_some(err),
            raw: frame.to_vec(),
        })
    }

    fn encode_job(&self, job: &RasterJob) -> Result<Vec<u8>, DriverError> {
        self.check_job(job, None)?;
        let dots = self
            .capabilities()
            .tape(job.tape_width_mm)
            .expect("checked")
            .printable_dots as u16;
        let vh = (3600 / self.capabilities().dpi) as u8;
        let lines = job.bitmap.height();
        let page = lines + 2 * self.margin_dots;
        if page > u32::from(u16::MAX) {
            return Err(DriverError::TooLong(page, u16::MAX.into()));
        }

        let mut out = Vec::new();
        if self.density != 0 {
            out.extend(cmd::density(self.density));
        }
        out.extend(cmd::graphics_mode());
        // 1 ジョブ = 1 枚。copies は送信側で繰り返す（モジュールの説明を参照）
        out.extend(cmd::page_length(page as u16));
        if self.margin_dots > 0 {
            out.extend(cmd::feed_dots(self.margin_dots as u16));
        }
        // SR3500P は最後に送った行がラベルの先頭（左端）になるので、末尾の行から送る（実機確認）
        for y in (0..lines).rev() {
            out.extend(cmd::feed_dots(1));
            cmd::raster_line(&mut out, vh, dots, job.bitmap.row(y));
        }
        out.push(cmd::FORM_FEED);
        out.extend_from_slice(&[cmd::ESC, b'@']);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Cut;
    use crate::bitmap::MonoBitmap;

    #[test]
    fn encodes_minimal_job_for_12mm() {
        let job = RasterJob {
            tape_width_mm: 12,
            bitmap: MonoBitmap::new(72, 2),
            copies: 1,
            cut: Cut::Full,
        };
        let out = Sr3500p::default().encode_job(&job).unwrap();
        let expected_head = [
            cmd::graphics_mode(),
            cmd::page_length(2),
            cmd::feed_dots(1),
            vec![0x1b, 0x2e, 0x00, 0x14, 0x14, 0x01, 72, 0x00],
        ]
        .concat();
        assert!(out.starts_with(&expected_head));
        assert!(out.ends_with(&[0x0c, 0x1b, b'@']));

        // copies は 1 ジョブに畳み込まない（送信側で繰り返す）
        let two = RasterJob {
            copies: 2,
            ..job.clone()
        };
        assert_eq!(Sr3500p::default().encode_job(&two).unwrap(), out);

        let dense = Sr3500p {
            density: 2,
            margin_dots: 10,
        };
        let out = dense.encode_job(&job).unwrap();
        let expected_head = [
            cmd::density(2),
            cmd::graphics_mode(),
            cmd::page_length(22),
            cmd::feed_dots(10),
            cmd::feed_dots(1),
        ]
        .concat();
        assert!(out.starts_with(&expected_head));
    }

    #[test]
    fn rejects_labels_longer_than_the_page_length_field() {
        let job = RasterJob {
            tape_width_mm: 12,
            bitmap: MonoBitmap::new(72, 1),
            copies: 1,
            cut: Cut::Full,
        };
        let long = Sr3500p {
            density: 0,
            margin_dots: 40_000,
        };
        assert_eq!(
            long.encode_job(&job),
            Err(DriverError::TooLong(80_001, 65_535))
        );
    }

    #[test]
    fn sends_lines_from_the_end_of_the_label() {
        let mut bm = MonoBitmap::new(72, 3);
        bm.set(0, 0, true); // ラベル先頭の行だけ dot0 を黒に
        let job = RasterJob {
            tape_width_mm: 12,
            bitmap: bm,
            copies: 1,
            cut: Cut::Full,
        };
        let out = Sr3500p::default().encode_job(&job).unwrap();
        let head = [0x1b, 0x2e, 0x00, 0x14, 0x14, 0x01, 72, 0x00];
        let rows: Vec<u8> = out
            .windows(9)
            .filter(|w| w[..8] == head)
            .map(|w| w[8])
            .collect();
        assert_eq!(rows, [0x00, 0x00, 0x80]);
    }

    #[test]
    fn parses_text_status() {
        let mut frame =
            b"@BDC ST\r\nST:00;ER:21;WR:00;RV:00;TW:03;TR:00;CT:03;OP:00;EI:80;".to_vec();
        frame.push(0xff);
        assert_eq!(frame.len(), STATUS_LEN);
        let mut stream = vec![0x00, 0x01];
        stream.extend(&frame);
        let s = Sr3500p::default().parse_status(&stream).unwrap();
        assert_eq!(s.tape_width_mm, Some(12));
        assert!(s.cover_open && !s.busy);
        assert_eq!(s.error_code, Some(0x21));

        let no_tape = String::from_utf8_lossy(&frame)
            .replace("ER:21", "ER:06")
            .replace("TW:03", "TW:FF");
        let s = Sr3500p::default().parse_status(no_tape.as_bytes()).unwrap();
        assert!(s.no_tape);
        assert_eq!(s.tape_width_mm, None);

        assert!(Sr3500p::default().parse_status(b"garbage").is_err());
    }

    #[test]
    fn status_requires_st_and_er() {
        let mut frame =
            b"@BDC ST\r\nST:00;ER:00;WR:00;RV:00;TW:03;TR:00;CT:03;OP:00;EI:80;".to_vec();
        frame.push(0xff);
        let d = Sr3500p::default();
        assert!(d.parse_status(&frame).is_ok());
        for (from, to) in [("ST:00", "XX:00"), ("ER:00", "XX:00"), ("ST:00", "ST:zz")] {
            let broken = String::from_utf8_lossy(&frame).replace(from, to);
            assert!(
                matches!(
                    d.parse_status(broken.as_bytes()),
                    Err(DriverError::BadStatus(_))
                ),
                "{from} -> {to}"
            );
        }
    }
}
