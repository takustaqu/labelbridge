// Bluetooth Classic SPP（RFCOMM）と Unix ドメインソケットの中継（macOS）。
//
//   ビルド: tools/bt-bridge/build.sh  → target/BTBridge.app
//   起動:   open -n target/BTBridge.app --args <機器名|アドレス> <ソケットのパス>
//
// /dev/cu.<name> は、いったん閉じるとリンクが張り直されなかったり、SPP ではない
// RFCOMM チャネル（Apple iAP）に繋がったりして安定しない。そのため IOBluetooth で直接、
// SerialPort（UUID 0x1101）のチャネルを開く。
// - Bluetooth の利用許可は「起動元のアプリ」で判定されるので、.app として `open` で起動する。
// - openRFCOMMChannelSync はランループの回っているメインスレッドからしか成功しない
//   （docs/protocol.md §3（接続））。
// - 接続してきたクライアント 1 つを中継し、切断されたら終了する。
import Foundation
import IOBluetooth

func log(_ s: String) { FileHandle.standardError.write("bt-bridge: \(s)\n".data(using: .utf8)!) }

/// 待つ間もメインのランループを回す（IOBluetooth のイベントや SDP の応答を処理するため）。
func pump(_ seconds: TimeInterval) {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: seconds))
}

let args = CommandLine.arguments.dropFirst()
guard args.count >= 2, let target = args.first, let socketPath = args.dropFirst().first else {
    log("usage: bt-bridge <device-name|address> <socket-path>")
    exit(2)
}

final class Bridge: NSObject, IOBluetoothRFCOMMChannelDelegate {
    var channel: IOBluetoothRFCOMMChannel?
    var client: Int32 = -1

    func rfcommChannelData(_ ch: IOBluetoothRFCOMMChannel!, data: UnsafeMutableRawPointer!, length: Int) {
        guard client >= 0 else { return }
        var off = 0
        while off < length {
            let n = Darwin.write(client, data + off, length - off)
            if n <= 0 { break }
            off += n
        }
    }

    func rfcommChannelClosed(_ ch: IOBluetoothRFCOMMChannel!) {
        log("RFCOMM channel closed")
        exit(0)
    }

    /// メインスレッドから呼ぶ。MTU ごとに分けて同期書き込みする。
    func send(_ bytes: [UInt8]) -> Bool {
        guard let ch = channel else { return false }
        let mtu = max(Int(ch.getMTU()), 1)
        var off = 0
        while off < bytes.count {
            let len = min(mtu, bytes.count - off)
            var chunk = Array(bytes[off..<off + len])
            let r = chunk.withUnsafeMutableBytes { ch.writeSync($0.baseAddress, length: UInt16(len)) }
            if r != kIOReturnSuccess {
                log(String(format: "writeSync failed: 0x%08X", r))
                return false
            }
            off += len
        }
        return true
    }
}

let paired = (IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice]) ?? []
guard let dev = paired.first(where: { $0.name == target || $0.addressString.lowercased() == target.lowercased() })
    ?? IOBluetoothDevice(addressString: target) else {
    log("device not found: \(target)")
    exit(2)
}

// ベースバンドを張り直す（電源の入れ直し後にリンクが残っていると RFCOMM が開けない）
if dev.isConnected() {
    dev.closeConnection()
    pump(1.0)
}
var r = dev.openConnection()
guard r == kIOReturnSuccess else {
    log(String(format: "openConnection failed: 0x%08X", r))
    exit(1)
}

// SerialPort（0x1101）のチャネルを SDP で探す。見つからなければ ch6（SR-R2500P の実測値）
var channelID: BluetoothRFCOMMChannelID = 6
if dev.performSDPQuery(nil) == kIOReturnSuccess {
    pump(2.0)
}
let spp = IOBluetoothSDPUUID(uuid16: 0x1101)!
var foundSPP = false
for case let rec as IOBluetoothSDPServiceRecord in dev.services ?? [] {
    var id: BluetoothRFCOMMChannelID = 0
    let hasChannel = rec.getRFCOMMChannelID(&id) == kIOReturnSuccess
    let isSPP = rec.matchesUUIDArray([spp])
    log("SDP: \(rec.getServiceName() ?? "(no name)") rfcomm=\(hasChannel ? String(id) : "-") spp=\(isSPP)")
    if isSPP, hasChannel, !foundSPP {
        channelID = id
        foundSPP = true
    }
}
if !foundSPP { log("SPP record not found in SDP; falling back to channel \(channelID)") }
// 機器のアドレスは個体を特定できるので、ログには末尾 2 桁だけ出す
let maskedAddress = (dev.addressString ?? "?").split(separator: "-").enumerated().map { $0.offset == 5 ? String($0.element) : "xx" }.joined(separator: "-")
log("device \(dev.name ?? "?") \(maskedAddress), SPP channel \(channelID)")

let bridge = Bridge()
// 電源投入直後などは失敗することがあるので、ランループを回しながら数回試す
var ch: IOBluetoothRFCOMMChannel?
for attempt in 1...5 {
    ch = nil
    r = dev.openRFCOMMChannelSync(&ch, withChannelID: channelID, delegate: bridge)
    if r == kIOReturnSuccess, ch != nil { break }
    log(String(format: "openRFCOMMChannelSync attempt %d failed: 0x%08X", attempt, r))
    if attempt == 3 {
        // 途中でベースバンドも張り直す
        dev.closeConnection()
        pump(1.0)
        _ = dev.openConnection()
    }
    pump(2.0)
}
guard r == kIOReturnSuccess, let channel = ch else {
    log("giving up")
    exit(1)
}
bridge.channel = channel
log("RFCOMM open, MTU \(channel.getMTU())")

// Unix ドメインソケットで 1 クライアントを待つ
unlink(socketPath)
let server = socket(AF_UNIX, SOCK_STREAM, 0)
var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
withUnsafeMutableBytes(of: &addr.sun_path) { buf in
    let p = Array(socketPath.utf8.prefix(buf.count - 1))
    buf.copyBytes(from: p)
}
let bound = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard bound == 0, listen(server, 1) == 0 else {
    log("cannot listen on \(socketPath)")
    exit(1)
}
log("listening on \(socketPath)")

Thread.detachNewThread {
    let c = accept(server, nil, nil)
    guard c >= 0 else { exit(1) }
    bridge.client = c
    log("client connected")
    var buf = [UInt8](repeating: 0, count: 4096)
    while true {
        let n = read(c, &buf, buf.count)
        if n <= 0 { break }
        let bytes = Array(buf[0..<n])
        var ok = true
        DispatchQueue.main.sync { ok = bridge.send(bytes) }
        if !ok { break }
    }
    log("client disconnected")
    DispatchQueue.main.async {
        channel.close()
        unlink(socketPath)
        exit(0)
    }
}

// 誰も接続してこなければ 60 秒で終わる
DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
    if bridge.client < 0 {
        log("no client; exiting")
        channel.close()
        unlink(socketPath)
        exit(0)
    }
}
RunLoop.main.run()
