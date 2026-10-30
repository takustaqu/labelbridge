//! SR5900P（LAN）。TCP 9100 に送るデータ部の生成と、UDP ステータス（20 バイト）の解釈。
//! UDP 9100 の TPRT 制御は labelbridge-transport::tprt、送信手順は labelbridge-cli の net.rs。

use crate::{
    Capabilities, Cut, DriverError, ModelId, MonoBitmap, PrinterDriver, PrinterStatus, RasterJob,
    cmd, model,
};

#[derive(Debug, Clone, Default)]
pub struct Sr5900p {
    /// 濃度 -5..=5（`D` = density + 5、0 が標準）。
    pub density: i8,
    /// 各ラベルの前後に見える余白（ドット）。None は本体の空白の幅（`Calibration::head_gap_dots`）。
    pub margin_dots: Option<u32>,
    /// カット位置の校正値。
    pub calibration: Calibration,
    /// ジョブの先頭のカットをハーフカットにする（先頭の空白を切れ端として落とさず、ラベルにつながったまま残す）。
    pub leading_half_cut: bool,
}

/// カット位置の校正値（ドット）。既定値は実機（9mm）で合わせたもの（docs/protocol.md §4）。
/// 本体はカットを次のラベルのデータの始まり（最後はデータの終わり）に入れ、ジョブの先頭と 1 枚目の後ろには
/// 自分で空白（ヘッド〜カッター間）を入れる。TS の `Sr5900pCalibration` と同じ。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Calibration {
    /// 本体がジョブの先頭と 1 枚目の後ろに入れる空白。余白をこれより小さくすると、先頭に空のページを入れる。
    pub head_gap_dots: i32,
    /// 2 枚目以降の前に足す空白 = 余白 + lead_adjust_dots。
    pub lead_adjust_dots: i32,
    /// 2 枚目以降（1 枚だけのときはその 1 枚）の後ろに足す空白 = 余白 + tail_adjust_dots。
    pub tail_adjust_dots: i32,
    /// 先頭に空のページを入れたとき、最初のラベルの後ろにさらに足す空白。
    pub first_tail_adjust_dots: i32,
}

impl Default for Calibration {
    fn default() -> Self {
        Calibration {
            head_gap_dots: 33,
            lead_adjust_dots: 10,
            tail_adjust_dots: -2,
            first_tail_adjust_dots: 7,
        }
    }
}

/// 空のページの行数。
const DUMMY_LINES: u32 = 8;

/// ジョブの並べ方（TS の `sr5900pLayout` と同じ）。(先頭に空のページを入れるか, 各ラベルの [前, 後ろ] の空白)。
pub fn layout(
    count: usize,
    cut: Cut,
    margin_dots: Option<u32>,
    c: Calibration,
) -> (bool, Vec<(u32, u32)>) {
    let pos = |v: i32| v.max(0) as u32;
    if cut == Cut::None {
        let m = margin_dots.unwrap_or(0);
        return (false, vec![(m, m); count]);
    }
    let m = margin_dots
        .map(|v| v as i32)
        .unwrap_or(c.head_gap_dots)
        .max(0);
    let later = (pos(m + c.lead_adjust_dots), pos(m + c.tail_adjust_dots));
    // 本体の空白より狭い余白は、先頭に空のページを入れて、本物のラベルを全部「2 枚目以降」にする
    if m < c.head_gap_dots {
        let mut pads = vec![later; count];
        if let Some(first) = pads.first_mut() {
            first.1 = pos(later.1 as i32 + c.first_tail_adjust_dots);
        }
        return (true, pads);
    }
    let extra = pos(m - c.head_gap_dots);
    if count == 1 {
        return (false, vec![(extra, later.1)]);
    }
    let mut pads = vec![later; count];
    pads[0] = (extra, extra);
    (false, pads)
}

/// ステータスのテープ幅コード（byte3）→ mm（docs/protocol.md §1）。`51`〜`5B` は `01`〜`0B` の別名。
pub fn tape_code_to_mm(code: u8) -> Option<u32> {
    let code = if (0x51..=0x5b).contains(&code) {
        code & 0x0f
    } else {
        code
    };
    Some(match code {
        0x01 => 6,
        0x02 => 9,
        0x03 => 12,
        0x04 => 18,
        0x05 => 24,
        0x06 => 36,
        0x07 => 50,
        0x0b => 4,
        _ => return None,
    })
}

/// `C` の値 [先頭, ラベルの間, ?, 末尾]（docs/protocol.md §4）。Half はラベルの間だけハーフカット（実機で確認した値）。
fn cut_value(cut: Cut) -> [u8; 4] {
    match cut {
        Cut::Full => [0x01, 0x01, 0x01, 0x01],
        Cut::Half => [0x01, 0x02, 0x01, 0x01],
        Cut::None => [0x00, 0x00, 0x00, 0x00],
    }
}

impl PrinterDriver for Sr5900p {
    fn capabilities(&self) -> &Capabilities {
        model(ModelId::Sr5900p)
    }

    fn status_request(&self) -> Result<Vec<u8>, DriverError> {
        // UDP の TPRT cmd=1 で取得するため ESC ストリームとしては存在しない
        Err(DriverError::NotImplemented(ModelId::Sr5900p))
    }

    /// TPRT 応答ヘッダの後ろ 20 バイト。
    fn parse_status(&self, b: &[u8]) -> Result<PrinterStatus, DriverError> {
        if b.len() < 20 || b[0] != 0x14 {
            return Err(DriverError::BadStatus(b.len()));
        }
        let err = b[2];
        Ok(PrinterStatus {
            tape_width_mm: tape_code_to_mm(b[3]),
            busy: b[1] != 0x00,
            state: b[1],
            no_tape: matches!(err, 0x06 | 0x42),
            cover_open: err == 0x21,
            error_code: (err != 0).then_some(err),
            raw: b.to_vec(),
        })
    }

    fn encode_job(&self, job: &RasterJob) -> Result<Vec<u8>, DriverError> {
        self.check_job(job, None)?;
        self.encode_pages(&[&job.bitmap], job.tape_width_mm, job.cut, job.copies)
    }
}

impl Sr5900p {
    /// 複数のラベルを 1 ジョブにする（TS の `encodeSr5900pPages` と同じ）。ラベルごとに `L T H s` + 行 + `0C` を続け、最後に `@`。
    /// `copies` は bitmaps を並べたものを繰り返す。ラベルの間のカットは `cut`（Half ならハーフカットでつながる）。
    /// bitmap はドライバ入力の向き（行 = 送り方向、幅 = 印字幅）。
    pub fn encode_pages(
        &self,
        bitmaps: &[&MonoBitmap],
        tape_width_mm: u32,
        cut: Cut,
        copies: u16,
    ) -> Result<Vec<u8>, DriverError> {
        let caps = self.capabilities();
        let tape = caps
            .tape(tape_width_mm)
            .ok_or(DriverError::UnsupportedTape(tape_width_mm))?;
        if cut == Cut::Half && !caps.half_cut {
            return Err(DriverError::UnsupportedCut(cut));
        }
        for b in bitmaps {
            if b.width() > tape.printable_dots {
                return Err(DriverError::BitmapTooWide {
                    got: b.width(),
                    max: tape.printable_dots,
                });
            }
        }
        let dots = tape.printable_dots as u16;

        // 1 ジョブに全部のページを並べる（ジョブを繰り返すと実機は印字しない。docs/protocol.md §4）
        let mut out = Vec::new();
        out.extend(cmd::job_boundary());
        out.extend(cmd::start_job());
        let mut c = cut_value(cut);
        if cut != Cut::None && self.leading_half_cut {
            c[0] = 0x02;
        }
        out.extend(cmd::frame(b'C', &c));
        out.extend(cmd::density(self.density));
        out.extend(cmd::g());
        let pages: Vec<&MonoBitmap> = (0..copies.max(1))
            .flat_map(|_| bitmaps.iter().copied())
            .collect();
        let (dummy, pads) = layout(pages.len(), cut, self.margin_dots, self.calibration);
        let page =
            |out: &mut Vec<u8>, lead: u32, n: u32, tail: u32, row: &dyn Fn(u32) -> Vec<u8>| {
                out.extend(cmd::length(lead + n + tail + 4));
                // 先頭の送りは 0（42 だとジョブの先頭で短い片が切り落とされる）
                out.extend(cmd::leading(0));
                out.extend(cmd::frame(b'H', &[0x05]));
                out.extend(cmd::frame(b's', &[0x00]));
                for _ in 0..lead {
                    cmd::raster_line(out, 0x00, dots, &[]);
                }
                // ラベルの末尾の行から送る（hikalium/sr5900p の gen_tcp_data と同じ。1 行の中は dot 0 = 上端）
                for y in (0..n).rev() {
                    cmd::raster_line(out, 0x00, dots, &row(y));
                }
                for _ in 0..tail {
                    cmd::raster_line(out, 0x00, dots, &[]);
                }
                out.push(cmd::FORM_FEED);
            };
        if dummy {
            page(&mut out, 0, DUMMY_LINES, 0, &|_| Vec::new());
        }
        for (bitmap, (lead, tail)) in pages.iter().zip(pads) {
            page(&mut out, lead, bitmap.height(), tail, &|y| {
                bitmap.row(y).to_vec()
            });
        }
        out.extend(cmd::job_boundary());
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bitmap::MonoBitmap;

    #[test]
    fn parses_captured_statuses() {
        let mut idle = [0u8; 20];
        idle[..9].copy_from_slice(&[0x14, 0, 0, 0x04, 0, 0, 0, 0, 0x40]);
        let s = Sr5900p::default().parse_status(&idle).unwrap();
        assert_eq!(
            (s.tape_width_mm, s.busy, s.no_tape),
            (Some(18), false, false)
        );

        let mut end = idle;
        end[2] = 0x42;
        let s = Sr5900p::default().parse_status(&end).unwrap();
        assert!(s.no_tape);
        assert_eq!(s.error_code, Some(0x42));

        let mut receiving = idle;
        receiving[1] = 0x03;
        receiving[3] = 0x53; // 12mm の別名
        let s = Sr5900p::default().parse_status(&receiving).unwrap();
        assert!(s.busy);
        assert_eq!((s.state, s.tape_width_mm), (0x03, Some(12)));

        assert!(Sr5900p::default().parse_status(&[0x14; 4]).is_err());
    }

    #[test]
    fn encodes_header_lines_and_footer() {
        let mut bm = MonoBitmap::new(144, 3);
        bm.fill_rect(0, 0, 8, 1); // ラベル先頭の行
        let job = RasterJob {
            tape_width_mm: 12,
            bitmap: bm,
            copies: 1,
            cut: Cut::Full,
        };
        let out = Sr5900p::default().encode_job(&job).unwrap();

        let header = [
            cmd::job_boundary(),
            cmd::start_job(),
            cmd::frame(b'C', &[1, 1, 1, 1]),
            cmd::density(0),
            cmd::g(),
            cmd::length(3 + 31 + 4),
            cmd::leading(0),
            cmd::frame(b'H', &[5]),
            cmd::frame(b's', &[0]),
        ]
        .concat();
        assert!(out.starts_with(&header));
        let line_len = 8 + 18;
        let body = &out[header.len()..header.len() + 3 * line_len];
        // 末尾から送るので、先頭の行は 3 行目に来る
        assert_eq!(body[2 * line_len + 8], 0xff);
        assert!(
            body[..2 * line_len]
                .iter()
                .skip(8)
                .take(18)
                .all(|&b| b == 0)
        );
        // 1 枚だけのときは後ろに補正の空白
        let tail = &out[header.len() + 3 * line_len..];
        let blanks = 31 * line_len;
        assert!(
            tail[..blanks]
                .chunks(line_len)
                .all(|l| l[8..].iter().all(|&b| b == 0))
        );
        assert_eq!(
            &tail[blanks..],
            [&[0x0c][..], &cmd::job_boundary()].concat()
        );
    }
}
