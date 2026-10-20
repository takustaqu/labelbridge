//! libusb 経由の USB Printer class（7/1/2）転送。
//!
//! 印刷データは bulk OUT、状態は制御転送で読む（docs/protocol.md）。

use std::time::Duration;

use rusb::{Direction, GlobalContext, TransferType, UsbContext};

use crate::{Result, Transport, TransportError};

pub const USB_VENDOR_ID: u16 = 0x0d8a;

impl From<rusb::Error> for TransportError {
    fn from(e: rusb::Error) -> Self {
        match e {
            rusb::Error::Timeout => Self::Timeout,
            rusb::Error::NoDevice => Self::Disconnected,
            other => Self::Io(std::io::Error::other(other)),
        }
    }
}

pub struct UsbTransport {
    handle: rusb::DeviceHandle<GlobalContext>,
    interface: u8,
    ep_out: u8,
    ep_in: Option<u8>,
}

impl UsbTransport {
    /// VID/PID で最初に見つかった機器の Printer class インターフェースを claim する。
    pub fn open(vid: u16, pid: u16) -> Result<Self> {
        let device = rusb::devices()?
            .iter()
            .find(|d| {
                d.device_descriptor()
                    .is_ok_and(|dd| dd.vendor_id() == vid && dd.product_id() == pid)
            })
            .ok_or(TransportError::Disconnected)?;
        let config = device.active_config_descriptor()?;
        let (interface, ep_out, ep_in) = config
            .interfaces()
            .flat_map(|i| i.descriptors())
            .find(|d| d.class_code() == 7)
            .map(|d| {
                let bulk = |dir| {
                    d.endpoint_descriptors()
                        .find(|e| e.transfer_type() == TransferType::Bulk && e.direction() == dir)
                        .map(|e| e.address())
                };
                (
                    d.interface_number(),
                    bulk(Direction::Out),
                    bulk(Direction::In),
                )
            })
            .ok_or(TransportError::Disconnected)?;
        let ep_out = ep_out.ok_or(TransportError::Disconnected)?;

        let handle = device.open()?;
        // Linux の usblp 対策。macOS / Windows では未対応エラーになるので無視する。
        let _ = handle.set_auto_detach_kernel_driver(true);
        handle.claim_interface(interface)?;
        Ok(Self {
            handle,
            interface,
            ep_out,
            ep_in,
        })
    }

    pub fn interface(&self) -> u8 {
        self.interface
    }

    /// IEEE 1284 デバイス ID（Printer class GET_DEVICE_ID）。
    pub fn device_id(&self) -> Result<String> {
        let mut buf = [0u8; 1024];
        let n = self.handle.read_control(
            0xa1,
            0x00,
            0,
            (self.interface as u16) << 8,
            &mut buf,
            Duration::from_secs(1),
        )?;
        // 先頭 2 バイトは BE の長さ
        let body = buf.get(2..n).unwrap_or_default();
        Ok(String::from_utf8_lossy(body).into_owned())
    }

    /// Printer class SOFT_RESET（bRequest 2）。受信途中の状態を捨てる。
    /// SR3500P では、ジョブの前に送らないと 2 回目以降のジョブが無視される（実機確認）。
    pub fn soft_reset(&self) -> Result<()> {
        self.handle.write_control(
            0x21,
            0x02,
            0,
            (self.interface as u16) << 8,
            &[],
            Duration::from_secs(1),
        )?;
        Ok(())
    }

    /// Printer class GET_PORT_STATUS（1 バイト。0x10 = Selected, 0x08 = No Error, 0x20 = Paper Empty）。
    pub fn port_status(&self) -> Result<u8> {
        let s = self.read_control(0xa1, 0x01, 0, (self.interface as u16) << 8, 1)?;
        s.first().copied().ok_or(TransportError::Timeout)
    }

    /// 任意の IN 制御転送（調査用）。
    pub fn read_control(
        &self,
        request_type: u8,
        request: u8,
        value: u16,
        index: u16,
        len: usize,
    ) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; len];
        let n = self.handle.read_control(
            request_type,
            request,
            value,
            index,
            &mut buf,
            Duration::from_secs(1),
        )?;
        buf.truncate(n);
        Ok(buf)
    }
}

impl Transport for UsbTransport {
    fn write_all(&mut self, mut data: &[u8]) -> Result<()> {
        while !data.is_empty() {
            let n = self
                .handle
                .write_bulk(self.ep_out, data, Duration::from_secs(5))?;
            data = &data[n..];
        }
        Ok(())
    }

    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        let ep = self.ep_in.ok_or(TransportError::Disconnected)?;
        match self.handle.read_bulk(ep, buf, timeout)? {
            0 => Err(TransportError::Timeout),
            n => Ok(n),
        }
    }
}

impl Drop for UsbTransport {
    fn drop(&mut self) {
        let _ = self.handle.release_interface(self.interface);
    }
}

/// 接続中の対応機種を列挙する（VID, PID, 製品名）。
pub fn list_supported_devices() -> Result<Vec<(u16, u16, String)>> {
    let ctx = GlobalContext::default();
    let mut out = Vec::new();
    for d in ctx.devices()?.iter() {
        let Ok(dd) = d.device_descriptor() else {
            continue;
        };
        if dd.vendor_id() != USB_VENDOR_ID {
            continue;
        }
        let name = d
            .open()
            .ok()
            .and_then(|h| h.read_product_string_ascii(&dd).ok())
            .unwrap_or_default();
        out.push((dd.vendor_id(), dd.product_id(), name));
    }
    Ok(out)
}
