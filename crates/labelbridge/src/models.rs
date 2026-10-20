//! 機種ごとの能力定義。値の根拠は docs/protocol.md。
//!
//! `printable_dots` は 1 ラスタ行（テープ幅方向）のドット数。

use crate::{Capabilities, Confidence::*, ModelId, TapeSpec, TransportKind::*};

const USB_VENDOR_ID: u16 = 0x0d8a;

const fn t(width_mm: u32, printable_dots: u32, confidence: crate::Confidence) -> TapeSpec {
    TapeSpec {
        width_mm,
        printable_dots,
        confidence,
    }
}

// 180dpi / 128 ドットヘッド / USB のみ: 公式取説（docs/protocol.md §2）。
// USB: 0d8a:0102、Printer class 7/1/2、bulk IN 0x81 / OUT 0x02 — 実機確認 2026-10-20。
// 12mm = 72 ドット/行で印字・カットを実機確認。他の幅は参考資料の 180dpi 表（未印字。docs/protocol.md）。
static SR3500P: Capabilities = Capabilities {
    model: ModelId::Sr3500p,
    display_name: "SR3500P",
    dpi: 180,
    head_dots: 128,
    tapes: &[
        t(4, 22, Inferred),
        t(6, 36, Inferred),
        t(9, 54, Inferred),
        t(12, 72, Verified),
        t(18, 108, Inferred),
        t(24, 128, Inferred),
    ],
    full_cut: true,
    half_cut: false,
    transports: &[Usb],
    usb_vendor_id: Some(USB_VENDOR_ID),
    usb_product_id: Some(0x0102),
    confidence: Verified,
    notes: "ESC/P2（ESC ( G + ESC ( C + ESC ( v + ESC .）形式。ジョブ前に USB SOFT_RESET。ステータスは ESC{Q のテキスト形式。",
};

// 360dpi / 384 ドット / USB + LAN: 公式取説。
// 印字ドット数: hikalium/sr5900p の mm_to_px（8 の倍数切り上げ）。
// LAN（UDP/TCP 9100）で 12mm の印字・カット・QR 読み取りを実機確認 2026-10-20。
static SR5900P: Capabilities = Capabilities {
    model: ModelId::Sr5900p,
    display_name: "SR5900P",
    dpi: 360,
    head_dots: 384,
    tapes: &[
        t(4, 40, Inferred),
        t(6, 72, Inferred),
        t(9, 104, Inferred),
        t(12, 144, Verified),
        t(18, 216, Inferred),
        t(24, 288, Inferred),
        t(36, 368, Inferred),
    ],
    full_cut: true,
    half_cut: true,
    transports: &[Tcp],
    usb_vendor_id: Some(USB_VENDOR_ID),
    usb_product_id: None,
    confidence: Verified,
    notes: "LAN: UDP 9100 で制御（TPRT ヘッダ）、TCP 9100 でデータ。行はラベル末尾から送る。",
};

// Bluetooth Classic SPP（RFCOMM ch6）— 12mm で印字・カット・QR 読み取りを実機確認 2026-10-20。
// 180dpi / テープ 4〜18mm / 印字ドット数: 参考資料の機種表・印字可能ドット表（docs/protocol.md §3）。
static SR_R2500P: Capabilities = Capabilities {
    model: ModelId::SrR2500p,
    display_name: "SR-R2500P",
    dpi: 180,
    head_dots: 128,
    tapes: &[
        t(4, 22, Inferred),
        t(6, 36, Inferred),
        t(9, 54, Inferred),
        t(12, 72, Verified),
        t(18, 108, Inferred),
    ],
    full_cut: true,
    half_cut: false,
    transports: &[Bluetooth],
    usb_vendor_id: Some(USB_VENDOR_ID),
    usb_product_id: None,
    confidence: Verified,
    notes: "commandLevel 5（ESC{ 系 + ESC .）。ステータスは ESC{I の 92 バイト。ESC{! は送らない（BT リンクが切れる）。",
};

pub fn model(id: ModelId) -> &'static Capabilities {
    match id {
        ModelId::Sr3500p => &SR3500P,
        ModelId::Sr5900p => &SR5900P,
        ModelId::SrR2500p => &SR_R2500P,
    }
}

pub fn all_models() -> impl Iterator<Item = &'static Capabilities> {
    [ModelId::Sr3500p, ModelId::Sr5900p, ModelId::SrR2500p]
        .into_iter()
        .map(model)
}

/// USB の VID:PID から機種を引く（本ライブラリが USB で扱える機種だけ）。
pub fn model_for_usb(vendor_id: u16, product_id: u16) -> Option<&'static Capabilities> {
    all_models()
        .find(|c| c.usb_vendor_id == Some(vendor_id) && c.usb_product_id == Some(product_id))
}

/// その接続方式で本ライブラリが扱える機種。
pub fn models_for(transport: crate::TransportKind) -> impl Iterator<Item = &'static Capabilities> {
    all_models().filter(move |c| c.transports.contains(&transport))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_up_models_by_connection() {
        assert_eq!(
            model_for_usb(USB_VENDOR_ID, 0x0102).map(|c| c.model),
            Some(ModelId::Sr3500p)
        );
        assert!(model_for_usb(USB_VENDOR_ID, 0xffff).is_none());
        assert_eq!(
            models_for(Bluetooth).map(|c| c.model).collect::<Vec<_>>(),
            [ModelId::SrR2500p]
        );
        assert_eq!(
            models_for(Tcp).map(|c| c.model).collect::<Vec<_>>(),
            [ModelId::Sr5900p]
        );
    }

    #[test]
    fn tapes_fit_within_head() {
        for m in all_models() {
            for t in m.tapes {
                assert!(
                    t.printable_dots <= m.head_dots,
                    "{} {}mm",
                    m.display_name,
                    t.width_mm
                );
            }
        }
    }
}
