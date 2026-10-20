//! 1bpp モノクロビットマップと mm↔dot 変換。
//!
//! 内部表現は行優先・MSB first・1=黒。ドライバ入力（[`crate::RasterJob`]）は
//! 「行 = テープ送り方向、幅 = テープ幅方向（dot 0 = ラベル上端）」の向き。
//! ラベル画像（x = 送り方向）からは [`MonoBitmap::transpose`] で変換する。

/// mm → dot（四捨五入）。
pub fn mm_to_dots(mm: f64, dpi: u32) -> u32 {
    (mm / 25.4 * dpi as f64).round().max(0.0) as u32
}

pub fn dots_to_mm(dots: u32, dpi: u32) -> f64 {
    dots as f64 * 25.4 / dpi as f64
}

/// [`MonoBitmap`] を作れなかった理由。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BitmapError {
    #[error("bitmap size {width}x{height} overflows the address space")]
    TooLarge { width: u32, height: u32 },
    #[error("gray buffer has {got} bytes, expected {expected} for the given size")]
    LengthMismatch { expected: usize, got: usize },
}

#[derive(Clone, PartialEq, Eq)]
pub struct MonoBitmap {
    width: u32,
    height: u32,
    stride: usize,
    data: Vec<u8>,
}

impl std::fmt::Debug for MonoBitmap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MonoBitmap({}x{})", self.width, self.height)
    }
}

impl MonoBitmap {
    /// 白紙のビットマップ。
    ///
    /// # Panics
    ///
    /// `stride * height` が `usize` に収まらないとき（32 bit 環境で巨大なサイズを渡した場合など）。
    /// 外部から来たサイズには [`MonoBitmap::try_new`] を使う。
    pub fn new(width: u32, height: u32) -> Self {
        match Self::try_new(width, height) {
            Ok(b) => b,
            Err(e) => panic!("{e}"),
        }
    }

    /// [`MonoBitmap::new`] の panic しない版。バイト数が `usize` に収まらなければ
    /// [`BitmapError::TooLarge`]。
    pub fn try_new(width: u32, height: u32) -> Result<Self, BitmapError> {
        let stride = (width as usize).div_ceil(8);
        let len = stride
            .checked_mul(height as usize)
            .filter(|&n| n <= isize::MAX as usize)
            .ok_or(BitmapError::TooLarge { width, height })?;
        Ok(Self {
            width,
            height,
            stride,
            data: vec![0; len],
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    /// 1 行あたりのバイト数（末尾は 0 パディング）。
    pub fn stride(&self) -> usize {
        self.stride
    }

    /// `y` 行目のバイト列（[`stride`](Self::stride) バイト）。
    ///
    /// # Panics
    ///
    /// `y >= height` のとき。範囲外かもしれない行には [`MonoBitmap::get_row`] を使う。
    pub fn row(&self, y: u32) -> &[u8] {
        match self.get_row(y) {
            Some(r) => r,
            None => panic!("row {y} out of range (height {})", self.height),
        }
    }

    /// `y` 行目のバイト列。`y >= height` なら `None`。
    pub fn get_row(&self, y: u32) -> Option<&[u8]> {
        if y >= self.height {
            return None;
        }
        let s = y as usize * self.stride;
        self.data.get(s..s + self.stride)
    }

    pub fn get(&self, x: u32, y: u32) -> bool {
        if x >= self.width || y >= self.height {
            return false;
        }
        self.data[y as usize * self.stride + x as usize / 8] & (0x80 >> (x % 8)) != 0
    }

    pub fn set(&mut self, x: u32, y: u32, black: bool) {
        if x >= self.width || y >= self.height {
            return;
        }
        let i = y as usize * self.stride + x as usize / 8;
        let m = 0x80 >> (x % 8);
        if black {
            self.data[i] |= m;
        } else {
            self.data[i] &= !m;
        }
    }

    /// 矩形を黒で塗る。ビットマップからはみ出す部分は無視する。
    pub fn fill_rect(&mut self, x: u32, y: u32, w: u32, h: u32) {
        for yy in y..y.saturating_add(h).min(self.height) {
            for xx in x..x.saturating_add(w).min(self.width) {
                self.set(xx, yy, true);
            }
        }
    }

    /// 8bit グレースケール（0=黒、行優先）から二値化。`threshold` 未満が黒。
    ///
    /// `gray.len()` が `width * height` と違えば [`BitmapError::LengthMismatch`]。
    pub fn from_gray(
        width: u32,
        height: u32,
        gray: &[u8],
        threshold: u8,
    ) -> Result<Self, BitmapError> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .ok_or(BitmapError::TooLarge { width, height })?;
        if gray.len() != expected {
            return Err(BitmapError::LengthMismatch {
                expected,
                got: gray.len(),
            });
        }
        let mut bm = Self::try_new(width, height)?;
        if width == 0 {
            return Ok(bm);
        }
        for (y, row) in gray.chunks_exact(width as usize).enumerate() {
            for (x, &v) in row.iter().enumerate() {
                if v < threshold {
                    bm.set(x as u32, y as u32, true);
                }
            }
        }
        Ok(bm)
    }

    /// 時計回り 90°。新しい幅 = 元の高さ。
    pub fn rotate_cw(&self) -> Self {
        let mut out = Self::new(self.height, self.width);
        for y in 0..self.height {
            for x in 0..self.width {
                if self.get(x, y) {
                    out.set(self.height - 1 - y, x, true);
                }
            }
        }
        out
    }

    /// 転置（x と y を入れ替える）。ラベル画像（x = 送り方向）→ ドライバ入力（行 = 送り方向）。
    pub fn transpose(&self) -> Self {
        let mut out = Self::new(self.height, self.width);
        for y in 0..self.height {
            for x in 0..self.width {
                if self.get(x, y) {
                    out.set(y, x, true);
                }
            }
        }
        out
    }

    pub fn flip_horizontal(&self) -> Self {
        let mut out = Self::new(self.width, self.height);
        for y in 0..self.height {
            for x in 0..self.width {
                if self.get(x, y) {
                    out.set(self.width - 1 - x, y, true);
                }
            }
        }
        out
    }

    /// `y` 行目がすべて白か。
    ///
    /// # Panics
    ///
    /// `y >= height` のとき（[`MonoBitmap::row`] と同じ）。
    pub fn is_row_blank(&self, y: u32) -> bool {
        self.row(y).iter().all(|&b| b == 0)
    }

    /// デバッグ用の ASCII 表示。
    pub fn to_ascii(&self) -> String {
        let mut s = String::new();
        for y in 0..self.height {
            for x in 0..self.width {
                s.push(if self.get(x, y) { '#' } else { '.' });
            }
            s.push('\n');
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mm_dot_conversion() {
        assert_eq!(mm_to_dots(25.4, 180), 180);
        assert_eq!(mm_to_dots(12.0, 360), 170);
        assert!((dots_to_mm(360, 360) - 25.4).abs() < 1e-9);
    }

    #[test]
    fn set_get_and_padding() {
        let mut b = MonoBitmap::new(10, 2);
        assert_eq!(b.stride(), 2);
        b.set(0, 0, true);
        b.set(9, 1, true);
        assert_eq!(b.row(0), [0x80, 0x00]);
        assert_eq!(b.row(1), [0x00, 0x40]);
        assert!(b.get(9, 1) && !b.get(8, 1));
        assert!(!b.get(100, 100));
    }

    #[test]
    fn row_access_out_of_range() {
        let b = MonoBitmap::new(10, 2);
        assert_eq!(b.get_row(1), Some(&[0u8, 0][..]));
        assert_eq!(b.get_row(2), None);
        assert!(std::panic::catch_unwind(|| b.row(2).len()).is_err());
    }

    #[test]
    fn from_gray_thresholds_and_checks_length() {
        let b = MonoBitmap::from_gray(3, 2, &[0, 200, 127, 128, 255, 10], 128).unwrap();
        assert_eq!(b.to_ascii(), "#.#\n..#\n");
        assert_eq!(
            MonoBitmap::from_gray(3, 2, &[0; 5], 128),
            Err(BitmapError::LengthMismatch {
                expected: 6,
                got: 5
            })
        );
        assert_eq!(MonoBitmap::from_gray(0, 4, &[], 128).unwrap().height(), 4);
    }

    #[test]
    fn huge_sizes_do_not_overflow() {
        // 長さの検査は確保より先なので、巨大なサイズでもメモリを取らずにエラーになる
        assert!(matches!(
            MonoBitmap::from_gray(u32::MAX, u32::MAX, &[], 0),
            Err(BitmapError::LengthMismatch { .. } | BitmapError::TooLarge { .. })
        ));
        #[cfg(target_pointer_width = "32")]
        assert!(MonoBitmap::try_new(u32::MAX, u32::MAX).is_err());
        let mut b = MonoBitmap::new(4, 4);
        b.fill_rect(2, 2, u32::MAX, u32::MAX);
        assert_eq!(b.to_ascii(), "....\n....\n..##\n..##\n");
    }

    #[test]
    fn transpose_swaps_axes() {
        let mut b = MonoBitmap::new(3, 2);
        b.set(2, 1, true);
        let t = b.transpose();
        assert_eq!((t.width(), t.height()), (2, 3));
        assert!(t.get(1, 2));
    }

    #[test]
    fn rotate_cw_moves_top_left_to_top_right() {
        let mut b = MonoBitmap::new(3, 2);
        b.set(0, 0, true);
        let r = b.rotate_cw();
        assert_eq!((r.width(), r.height()), (2, 3));
        assert_eq!(r.to_ascii(), ".#\n..\n..\n");
    }
}
