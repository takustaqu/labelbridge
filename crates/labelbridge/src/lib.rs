//! 機種別の能力定義（解像度・印字可能幅・カット）と印刷データ生成。
//!
//! 能力値のうち実機・一次情報で確認していないものは `Confidence::Unverified` とする。
//! プロトコル調査の根拠は docs/protocol.md を参照。

pub mod bitmap;
pub mod cmd;
mod models;
pub mod sr3500p;
mod sr5900p;
pub mod srr2500p;

use serde::Serialize;

pub use bitmap::{BitmapError, MonoBitmap, dots_to_mm, mm_to_dots};
pub use models::{all_models, model, model_for_usb, models_for};
pub use sr3500p::Sr3500p;
pub use sr5900p::{Sr5900p, tape_code_to_mm};
pub use srr2500p::SrR2500p;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum ModelId {
    Sr3500p,
    Sr5900p,
    SrR2500p,
}

impl ModelId {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().replace(['-', '_'], "").as_str() {
            "sr3500p" => Some(Self::Sr3500p),
            "sr5900p" => Some(Self::Sr5900p),
            "srr2500p" => Some(Self::SrR2500p),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Confidence {
    /// 実機または一次資料で確認済み
    Verified,
    /// 参考実装・二次情報からの推定
    Inferred,
    /// 未確認（仮置き）
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TransportKind {
    Usb,
    Tcp,
    Bluetooth,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TapeSpec {
    pub width_mm: u32,
    /// テープ幅方向の印字可能ドット数
    pub printable_dots: u32,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    pub model: ModelId,
    pub display_name: &'static str,
    pub dpi: u32,
    /// ヘッドのドット数（1 ラインの最大ドット数）
    pub head_dots: u32,
    pub tapes: &'static [TapeSpec],
    pub full_cut: bool,
    pub half_cut: bool,
    pub transports: &'static [TransportKind],
    pub usb_vendor_id: Option<u16>,
    pub usb_product_id: Option<u16>,
    pub confidence: Confidence,
    pub notes: &'static str,
}

impl Capabilities {
    pub fn tape(&self, width_mm: u32) -> Option<&TapeSpec> {
        self.tapes.iter().find(|t| t.width_mm == width_mm)
    }
}

/// ドライバへの入力。`bitmap` はプリンターのライン方向に揃え済み
/// （幅 = テープ幅方向のドット数、高さ = 送り方向のライン数）。
#[derive(Debug, Clone)]
pub struct RasterJob {
    pub tape_width_mm: u32,
    pub bitmap: MonoBitmap,
    pub copies: u16,
    pub cut: Cut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cut {
    Full,
    Half,
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PrinterStatus {
    pub tape_width_mm: Option<u32>,
    pub cover_open: bool,
    pub no_tape: bool,
    /// ST（状態コード）が 0（待機）以外。
    pub busy: bool,
    /// ST の生の値（docs/protocol.md §1「ステータスの値」）。
    pub state: u8,
    pub error_code: Option<u8>,
    pub raw: Vec<u8>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DriverError {
    #[error("tape width {0}mm is not supported by this model")]
    UnsupportedTape(u32),
    #[error("bitmap width {got} exceeds printable dots {max} for this tape")]
    BitmapTooWide { got: u32, max: u32 },
    #[error("tape mismatch: job is {job}mm but printer has {loaded}mm")]
    TapeMismatch { job: u32, loaded: u32 },
    #[error("cut mode {0:?} is not supported by this model")]
    UnsupportedCut(Cut),
    #[error("label is {0} lines long; this model takes at most {1}")]
    TooLong(u32, u32),
    #[error("malformed status response ({0} bytes)")]
    BadStatus(usize),
    #[error("not implemented for {0:?} yet")]
    NotImplemented(ModelId),
}

pub trait PrinterDriver {
    fn capabilities(&self) -> &Capabilities;

    /// ステータス要求コマンド。
    fn status_request(&self) -> Result<Vec<u8>, DriverError>;
    fn parse_status(&self, bytes: &[u8]) -> Result<PrinterStatus, DriverError>;

    /// 1 ジョブ分の送信バイト列を生成する。
    ///
    /// `job.copies` の扱いは機種で異なる: SR5900P と SR-R2500P は部数ぶんのページを 1 ジョブに入れる。
    /// SR3500P は 1 ジョブ = 1 枚で、送信側が部数ぶんジョブを繰り返す（`sr3500p` のモジュール説明）。
    fn encode_job(&self, job: &RasterJob) -> Result<Vec<u8>, DriverError>;

    /// 共通の事前検査（テープ幅・画像幅・カット方式・装着テープとの一致）。
    fn check_job(
        &self,
        job: &RasterJob,
        status: Option<&PrinterStatus>,
    ) -> Result<(), DriverError> {
        let caps = self.capabilities();
        let tape = caps
            .tape(job.tape_width_mm)
            .ok_or(DriverError::UnsupportedTape(job.tape_width_mm))?;
        let cut_ok = match job.cut {
            Cut::Full => caps.full_cut,
            Cut::Half => caps.half_cut,
            Cut::None => true,
        };
        if !cut_ok {
            return Err(DriverError::UnsupportedCut(job.cut));
        }
        if job.bitmap.width() > tape.printable_dots {
            return Err(DriverError::BitmapTooWide {
                got: job.bitmap.width(),
                max: tape.printable_dots,
            });
        }
        if let Some(loaded) = status.and_then(|s| s.tape_width_mm)
            && loaded != job.tape_width_mm
        {
            return Err(DriverError::TapeMismatch {
                job: job.tape_width_mm,
                loaded,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_model_ids() {
        assert_eq!(ModelId::parse("SR-R2500P"), Some(ModelId::SrR2500p));
        assert_eq!(ModelId::parse("sr3500p"), Some(ModelId::Sr3500p));
        assert_eq!(ModelId::parse("SR150"), None);
    }

    #[test]
    fn check_job_detects_tape_problems() {
        let d = Sr5900p::default();
        let tape = d.capabilities().tapes[0];
        let ok = RasterJob {
            tape_width_mm: tape.width_mm,
            bitmap: MonoBitmap::new(tape.printable_dots, 10),
            copies: 1,
            cut: Cut::Full,
        };
        assert_eq!(d.check_job(&ok, None), Ok(()));

        let wide = RasterJob {
            bitmap: MonoBitmap::new(tape.printable_dots + 1, 10),
            ..ok.clone()
        };
        assert!(matches!(
            d.check_job(&wide, None),
            Err(DriverError::BitmapTooWide { .. })
        ));

        let bogus = RasterJob {
            tape_width_mm: 13,
            ..ok.clone()
        };
        assert_eq!(
            d.check_job(&bogus, None),
            Err(DriverError::UnsupportedTape(13))
        );

        let other = d
            .capabilities()
            .tapes
            .iter()
            .find(|t| t.width_mm != tape.width_mm)
            .unwrap();
        let status = PrinterStatus {
            tape_width_mm: Some(other.width_mm),
            ..Default::default()
        };
        assert!(matches!(
            d.check_job(&ok, Some(&status)),
            Err(DriverError::TapeMismatch { .. })
        ));

        // ハーフカット非対応機では Half を拒む
        let half = RasterJob {
            cut: Cut::Half,
            ..ok.clone()
        };
        assert_eq!(
            SrR2500p::default().check_job(&half, None),
            Err(DriverError::UnsupportedCut(Cut::Half))
        );
        assert_eq!(d.check_job(&half, None), Ok(()));
    }
}
