//! シリアルデバイス（macOS の `/dev/cu.<name>` など）経由の転送。
//!
//! Bluetooth Classic の SPP は、ペアリング済みなら OS がシリアルポートとして見せる
//! （macOS: `/dev/cu.SR-R2500P`）。open すると RFCOMM が張られる。
//! 端末制御（改行変換など）は raw モードで無効にする。

use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::Duration;

use crate::{Result, Transport, TransportError};

pub struct SerialTransport {
    fd: OwnedFd,
}

fn last_err() -> TransportError {
    TransportError::Io(std::io::Error::last_os_error())
}

impl SerialTransport {
    pub fn open(path: &str) -> Result<Self> {
        let c = CString::new(path).map_err(|e| TransportError::Io(std::io::Error::other(e)))?;
        // O_NONBLOCK: モデム制御線を待たずに開く（RFCOMM の接続はここで始まる）
        let raw =
            unsafe { libc::open(c.as_ptr(), libc::O_RDWR | libc::O_NOCTTY | libc::O_NONBLOCK) };
        if raw < 0 {
            return Err(last_err());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        unsafe {
            let mut tio: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(raw, &mut tio) == 0 {
                libc::cfmakeraw(&mut tio);
                tio.c_cflag |= libc::CLOCAL | libc::CREAD;
                libc::tcsetattr(raw, libc::TCSANOW, &tio);
            }
            // 以降はブロッキング I/O（読み込みのタイムアウトは poll で扱う）
            let flags = libc::fcntl(raw, libc::F_GETFL);
            libc::fcntl(raw, libc::F_SETFL, flags & !libc::O_NONBLOCK);
        }
        Ok(Self { fd })
    }

    fn poll(&self, events: i16, timeout: Duration) -> Result<bool> {
        let mut p = libc::pollfd {
            fd: self.fd.as_raw_fd(),
            events,
            revents: 0,
        };
        let ms = timeout.as_millis().min(i32::MAX as u128) as i32;
        let n = unsafe { libc::poll(&mut p, 1, ms) };
        if n < 0 {
            return Err(last_err());
        }
        if p.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0
            && p.revents & events == 0
        {
            return Err(TransportError::Disconnected);
        }
        Ok(n > 0)
    }
}

impl Transport for SerialTransport {
    fn write_all(&mut self, mut data: &[u8]) -> Result<()> {
        while !data.is_empty() {
            if !self.poll(libc::POLLOUT, Duration::from_secs(30))? {
                return Err(TransportError::Timeout);
            }
            let n = unsafe { libc::write(self.fd.as_raw_fd(), data.as_ptr().cast(), data.len()) };
            if n < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::Interrupted
                {
                    continue;
                }
                return Err(e.into());
            }
            data = &data[n as usize..];
        }
        Ok(())
    }

    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        if !self.poll(libc::POLLIN, timeout)? {
            return Err(TransportError::Timeout);
        }
        let n = unsafe { libc::read(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        match n {
            n if n < 0 => Err(last_err()),
            0 => Err(TransportError::Disconnected),
            n => Ok(n as usize),
        }
    }
}
