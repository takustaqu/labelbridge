//! SR5900P（LAN）。TCP 9100 に送るデータ部の生成と、UDP ステータス（20 バイト）の解釈。
//! UDP 9100 の TPRT 制御は labelbridge-transport::tprt、送信手順は labelbridge-cli の net.rs。

use crate::{
    Capabilities, Cut, DriverError, ModelId, PrinterDriver, PrinterStatus, RasterJob, cmd, model,
};

#[derive(Debug, Clone, Default)]
pub struct Sr5900p {
    /// 濃度 -5..=5（`D` = density + 5、0 が標準）。
    pub density: i8,
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

/// `C` の値（ハーフカット対応機。docs/protocol.md §1）。
fn cut_value(cut: Cut) -> [u8; 4] {
    match cut {
        Cut::Full => [0x01, 0x01, 0x01, 0x01],
        Cut::Half => [0x02, 0x02, 0x01, 0x01],
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
        let tape = self
            .capabilities()
            .tape(job.tape_width_mm)
            .expect("checked");
        let dots = tape.printable_dots as u16;
        let lines = job.bitmap.height();

        let mut out = Vec::new();
        for _ in 0..job.copies.max(1) {
            out.extend(cmd::job_boundary());
            out.extend(cmd::start_job());
            out.extend(cmd::frame(b'C', &cut_value(job.cut)));
            out.extend(cmd::density(self.density));
            out.extend(cmd::g());
            out.extend(cmd::length(lines + 4));
            out.extend(cmd::leading(42));
            out.extend(cmd::frame(b'H', &[0x05]));
            out.extend(cmd::frame(b's', &[0x00]));
            // ラベルの末尾の行から送る（hikalium/sr5900p の gen_tcp_data と同じ。1 行の中は dot 0 = 上端）
            for y in (0..lines).rev() {
                cmd::raster_line(&mut out, 0x00, dots, job.bitmap.row(y));
            }
            out.push(cmd::FORM_FEED);
            out.extend(cmd::job_boundary());
        }
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
            cmd::length(7),
            cmd::leading(42),
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
        assert_eq!(
            &out[header.len() + 3 * line_len..],
            [&[0x0c][..], &cmd::job_boundary()].concat()
        );
    }
}
