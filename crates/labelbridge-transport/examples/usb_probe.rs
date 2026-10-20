//! 対応機種（USB）のデスクリプタと状態を読む。プリンターへは書き込まない。
//!
//!   cargo run -p labelbridge-transport --features usb --example usb_probe

use labelbridge_transport::usb::{USB_VENDOR_ID, UsbTransport, list_supported_devices};
use rusb::UsbContext;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let found = list_supported_devices()?;
    if found.is_empty() {
        println!("対応機種（VID {USB_VENDOR_ID:#06x}）が見つかりません");
        return Ok(());
    }
    for (vid, pid, name) in found {
        println!("== {name} {vid:04x}:{pid:04x}");
        dump_descriptors(vid, pid)?;
        match UsbTransport::open(vid, pid) {
            Ok(t) => {
                println!("claim: ok (interface {})", t.interface());
                match t.device_id() {
                    Ok(id) => println!("device id: {id}"),
                    Err(e) => println!("device id: error {e}"),
                }
                // 読み取り専用の制御転送をいくつか試す
                let probes: &[(&str, u8, u8, u16, u16, usize)] = &[
                    ("printer GET_PORT_STATUS", 0xa1, 0x01, 0, 0, 1),
                    ("vendor 0xC1/0x01 len8 (SR3700P)", 0xc1, 0x01, 0, 0, 8),
                    ("vendor 0xC1/0x01 len64", 0xc1, 0x01, 0, 0, 64),
                    ("vendor 0xC0/0x01 len8 (device)", 0xc0, 0x01, 0, 0, 8),
                    ("vendor 0xC1/0x00 len8", 0xc1, 0x00, 0, 0, 8),
                    ("vendor 0xC1/0x02 len8", 0xc1, 0x02, 0, 0, 8),
                ];
                for (label, rt, rq, v, i, len) in probes {
                    match t.read_control(*rt, *rq, *v, *i, *len) {
                        Ok(s) => println!("{label}: {}", hex(&s)),
                        Err(e) => println!("{label}: error {e}"),
                    }
                }
            }
            Err(e) => println!("claim: failed {e}"),
        }
    }
    Ok(())
}

fn dump_descriptors(vid: u16, pid: u16) -> rusb::Result<()> {
    let ctx = rusb::GlobalContext::default();
    for d in ctx.devices()?.iter() {
        let dd = d.device_descriptor()?;
        if (dd.vendor_id(), dd.product_id()) != (vid, pid) {
            continue;
        }
        println!(
            "usb {} device {} class {:02x}/{:02x}/{:02x} ep0 {} speed {:?}",
            dd.usb_version(),
            dd.device_version(),
            dd.class_code(),
            dd.sub_class_code(),
            dd.protocol_code(),
            dd.max_packet_size(),
            d.speed()
        );
        let c = d.active_config_descriptor()?;
        println!(
            "config {} max power {}mA self-powered {}",
            c.number(),
            c.max_power(),
            c.self_powered()
        );
        for i in c.interfaces() {
            for a in i.descriptors() {
                println!(
                    "  interface {} alt {} class {:02x}/{:02x}/{:02x}",
                    a.interface_number(),
                    a.setting_number(),
                    a.class_code(),
                    a.sub_class_code(),
                    a.protocol_code()
                );
                for e in a.endpoint_descriptors() {
                    println!(
                        "    ep {:#04x} {:?} {:?} max packet {}",
                        e.address(),
                        e.direction(),
                        e.transfer_type(),
                        e.max_packet_size()
                    );
                }
            }
        }
    }
    Ok(())
}

fn hex(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{x:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}
