//! 対応機種に共通のコマンド体系（docs/protocol.md §1）。
//!
//! - 制御: `ESC { len cmd params.. ck }`  len = cmd から `}` までのバイト数、ck = sum(cmd, params) & 0xFF
//! - ラスタ: `ESC . c v h m nL nH data..`  1 行 = テープ幅方向 1 列、MSB first、c=0 は非圧縮
//! - ページ終了 `0C`、ジョブ終了 `@`
//!
//! 出典は docs/protocol.md。

pub const ESC: u8 = 0x1b;
pub const FORM_FEED: u8 = 0x0c;

pub fn frame(cmd: u8, params: &[u8]) -> Vec<u8> {
    let len = u8::try_from(params.len() + 3).expect("ESC{ payload too long");
    let ck = params.iter().fold(cmd, |a, &b| a.wrapping_add(b));
    let mut v = Vec::with_capacity(params.len() + 6);
    v.extend_from_slice(&[ESC, b'{', len, cmd]);
    v.extend_from_slice(params);
    v.extend_from_slice(&[ck, b'}']);
    v
}

/// `@`: ジョブ区切り（先頭・末尾）。
pub fn job_boundary() -> Vec<u8> {
    frame(b'@', &[])
}

/// `{ "ST"`: ネットワーク機のジョブ開始。
pub fn start_job() -> Vec<u8> {
    frame(b'{', &[0x00, 0x00, b'S', b'T'])
}

/// `D`: 濃度。-5..=+5 を 0x00..=0x0A に写す（0 = 0x05 標準）。
/// メーカーの UI は -3..=+3 の範囲だが、プリンターは 0x00..=0x0A を受け付ける。
pub fn density(level: i8) -> Vec<u8> {
    frame(b'D', &[(5 + level.clamp(-5, 5)) as u8])
}

pub fn g() -> Vec<u8> {
    frame(b'G', &[])
}

/// `L`: 送り方向の長さ（ドット）。
pub fn length(dots: u32) -> Vec<u8> {
    frame(b'L', &dots.to_le_bytes())
}

/// `T`: 先頭の余白（ドット）。
pub fn leading(dots: u16) -> Vec<u8> {
    frame(b'T', &dots.to_le_bytes())
}

/// `ESC ( c nL nH data..`（拡張コマンド）。
pub fn esc_paren(cmd: u8, data: &[u8]) -> Vec<u8> {
    let mut v = vec![ESC, b'(', cmd];
    v.extend_from_slice(&(data.len() as u16).to_le_bytes());
    v.extend_from_slice(data);
    v
}

/// `ESC ( G 01 00 01`: グラフィックスモード選択。これが無いと `ESC .` のラスタは無視される。
pub fn graphics_mode() -> Vec<u8> {
    esc_paren(b'G', &[0x01])
}

/// `ESC ( C 02 00 n`: ページ長（ドット）。これが無いとジョブ全体が無視される。
pub fn page_length(dots: u16) -> Vec<u8> {
    esc_paren(b'C', &dots.to_le_bytes())
}

/// `ESC ( v 02 00 n`: 縦方向の相対移動（ドット）。
pub fn feed_dots(dots: u16) -> Vec<u8> {
    esc_paren(b'v', &dots.to_le_bytes())
}

/// ラスタ 1 行。`row` は MSB first、`dots` ビット分を使い不足は 0 で埋める。
pub fn raster_line(out: &mut Vec<u8>, vh: u8, dots: u16, row: &[u8]) {
    let n = (dots as usize).div_ceil(8);
    out.extend_from_slice(&[ESC, b'.', 0x00, vh, vh, 0x01]);
    out.extend_from_slice(&dots.to_le_bytes());
    let take = row.len().min(n);
    out.extend_from_slice(&row[..take]);
    out.resize(out.len() + (n - take), 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期待値は SR3700P / SR5900P の実機キャプチャ由来のバイト列。
    #[test]
    fn matches_captured_frames() {
        assert_eq!(
            frame(b'C', &[0x01, 0x01, 0x01, 0x01]),
            [0x1b, 0x7b, 0x07, 0x43, 0x01, 0x01, 0x01, 0x01, 0x47, 0x7d]
        );
        assert_eq!(density(0), [0x1b, 0x7b, 0x04, 0x44, 0x05, 0x49, 0x7d]);
        assert_eq!(g(), [0x1b, 0x7b, 0x03, 0x47, 0x47, 0x7d]);
        assert_eq!(job_boundary(), [0x1b, 0x7b, 0x03, 0x40, 0x40, 0x7d]);
        assert_eq!(
            start_job(),
            [0x1b, 0x7b, 0x07, 0x7b, 0x00, 0x00, 0x53, 0x54, 0x22, 0x7d]
        );
        assert_eq!(
            leading(42),
            [0x1b, 0x7b, 0x05, 0x54, 0x2a, 0x00, 0x7e, 0x7d]
        );
        assert_eq!(
            length(0xaa),
            [0x1b, 0x7b, 0x07, 0x4c, 0xaa, 0x00, 0x00, 0x00, 0xf6, 0x7d]
        );
    }

    #[test]
    fn escp2_commands() {
        assert_eq!(graphics_mode(), [0x1b, 0x28, 0x47, 0x01, 0x00, 0x01]);
        assert_eq!(feed_dots(1), [0x1b, 0x28, 0x76, 0x02, 0x00, 0x01, 0x00]);
        assert_eq!(
            page_length(0x0123),
            [0x1b, 0x28, 0x43, 0x02, 0x00, 0x23, 0x01]
        );
    }

    #[test]
    fn raster_line_pads_to_dot_count() {
        let mut v = Vec::new();
        raster_line(&mut v, 0x0d, 56, &[0xff]);
        assert_eq!(v[..8], [0x1b, 0x2e, 0x00, 0x0d, 0x0d, 0x01, 0x38, 0x00]);
        assert_eq!(v[8..], [0xff, 0, 0, 0, 0, 0, 0]);
    }
}
