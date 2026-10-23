import Foundation

/// Orb protocol version 1: application messages and BLE fragmentation. `../orb-firmware/src/message.rs` and `fragment.rs` implement the
/// same wire format; the golden vectors in the tests are asserted on both sides (see docs/orb-protocol-vectors.md). Opcodes are PROVISIONAL.
///
///     | opcode: u8 | message id: u16 | session generation: u16 | body |      (big-endian)
public enum OrbV1 {
    public static let protocolVersion: UInt8 = 1
    public static let maxMessageLength = 256
    public static let headerLength = 5
    public static let fragmentHeaderLength = 4

    public typealias AttemptID = [UInt8]            // 16 bytes: the terminal's attempt UUID

    public static func attemptID(_ uuid: UUID) -> AttemptID { withUnsafeBytes(of: uuid.uuid) { Array($0) } }

    public enum HandshakeKind: UInt8 { case bind = 0, resume = 1 }
    public enum Purpose: UInt8 { case payment = 1, lookup = 2, staff = 3 }
    public enum PaymentOutcome: UInt8 { case processing = 0, completed = 1, declined = 2, unknown = 3 }
    public enum LightMode: UInt8 { case normal = 0, identify = 1, emergency = 2 }
    public enum State: UInt8 {
        case starting = 0, pairing, boundDisconnected, connectedIdle, awaitingPayment, processing, completed, declined, updating, shuttingDown
    }
    public enum Reason: UInt8 {
        case ok = 0, busy, notConnected, staleSession, staleAttempt, alreadyCaptured, unsupported, badRequest, proximityNotMet, unauthorized
        case unresolvedAttempt, timeout, unreadable, unsupportedTag
    }

    public struct Header: Equatable {
        public var messageID: UInt16
        public var session: UInt16
        public init(messageID: UInt16, session: UInt16) { self.messageID = messageID; self.session = session }
    }

    public struct Battery: Equatable {
        public var percent: UInt8?, millivolts: UInt16, charging: Bool, externalPower: Bool, low: Bool, critical: Bool, temperatureC: Int8?
        public init(percent: UInt8?, millivolts: UInt16, charging: Bool, externalPower: Bool, low: Bool, critical: Bool, temperatureC: Int8?) {
            self.percent = percent; self.millivolts = millivolts; self.charging = charging; self.externalPower = externalPower
            self.low = low; self.critical = critical; self.temperatureC = temperatureC
        }
    }

    public enum Message: Equatable {
        // terminal -> Orb
        case handshake(kind: HandshakeKind, protocolVersion: UInt8, nonce: [UInt8], proof: [UInt8])
        case heartbeat(counter: UInt32)
        case beginPayment(attempt: AttemptID, amountCents: UInt64, currency: String, timeoutSeconds: UInt8)
        case beginRead(purpose: Purpose, attempt: AttemptID, timeoutSeconds: UInt8)
        case cancel(attempt: AttemptID)
        case paymentStatus(attempt: AttemptID, outcome: PaymentOutcome)
        case getStatus
        case configure(volume: UInt8, muted: Bool)
        case setLightMode(LightMode, durationSeconds: UInt16)
        case eventAck(of: UInt16)                   // confirms an Orb event (StateChanged, TapCaptured, Error) so the Orb stops resending it
        // Orb -> terminal
        case hello(uid: [UInt8], model: String, firmware: String, protocolVersion: UInt8, capabilities: UInt16, nonce: [UInt8])
        case handshakeResult(accepted: Bool, reason: Reason, proof: [UInt8])
        case commandAck(of: UInt16, accepted: Bool, reason: Reason)
        case stateChanged(State)
        case tapCaptured(purpose: Purpose, attempt: AttemptID, url: String)
        case battery(Battery)
        case error(reason: Reason, attempt: AttemptID)
    }

    public enum CodecError: Error, Equatable { case truncated, unknownOpcode(UInt8), badBody, tooLong }

    // MARK: encode

    public static func encode(_ m: Message, _ h: Header) throws -> [UInt8] {
        var b = [UInt8]()
        func u16(_ v: UInt16) { b += [UInt8(v >> 8), UInt8(v & 0xFF)] }
        func fixed(_ a: [UInt8], _ n: Int) throws { guard a.count == n else { throw CodecError.badBody }; b += a }
        func str8(_ s: String) throws { let u = Array(s.utf8); guard u.count < 256 else { throw CodecError.tooLong }; b.append(UInt8(u.count)); b += u }
        let op: UInt8
        switch m {
        case .handshake: op = 0x01
        case .heartbeat: op = 0x02
        case .beginPayment: op = 0x03
        case .beginRead: op = 0x04
        case .cancel: op = 0x05
        case .paymentStatus: op = 0x06
        case .getStatus: op = 0x07
        case .configure: op = 0x08
        case .setLightMode: op = 0x09
        case .eventAck: op = 0x0A
        case .hello: op = 0x81
        case .handshakeResult: op = 0x82
        case .commandAck: op = 0x83
        case .stateChanged: op = 0x84
        case .tapCaptured: op = 0x85
        case .battery: op = 0x86
        case .error: op = 0x87
        }
        b.append(op); u16(h.messageID); u16(h.session)
        switch m {
        case .handshake(let k, let p, let n, let pr): b += [k.rawValue, p]; try fixed(n, 16); try fixed(pr, 32)
        case .heartbeat(let c): b += (0..<4).map { UInt8((c >> UInt32(24 - 8 * $0)) & 0xFF) }
        case .beginPayment(let a, let amt, let cur, let t):
            try fixed(a, 16); b += (0..<8).map { UInt8((amt >> UInt64(56 - 8 * $0)) & 0xFF) }; try fixed(Array(cur.utf8), 3); b.append(t)
        case .beginRead(let p, let a, let t): b.append(p.rawValue); try fixed(a, 16); b.append(t)
        case .cancel(let a): try fixed(a, 16)
        case .paymentStatus(let a, let o): try fixed(a, 16); b.append(o.rawValue)
        case .getStatus: break
        case .configure(let v, let mu): b += [v, mu ? 1 : 0]
        case .setLightMode(let mode, let d): b.append(mode.rawValue); u16(d)
        case .eventAck(let of): u16(of)
        case .hello(let uid, let model, let fw, let p, let cap, let nonce): try fixed(uid, 6); try fixed(nonce, 16); b.append(p); u16(cap); try str8(model); try str8(fw)
        case .handshakeResult(let ok, let r, let proof): b += [ok ? 1 : 0, r.rawValue]; try fixed(proof, 32)
        case .commandAck(let of, let ok, let r): u16(of); b += [ok ? 1 : 0, r.rawValue]
        case .stateChanged(let s): b.append(s.rawValue)
        case .tapCaptured(let p, let a, let url): b.append(p.rawValue); try fixed(a, 16); b += Array(url.utf8)
        case .battery(let x):
            b.append(x.percent ?? 0xFF); u16(x.millivolts)
            b.append((x.charging ? 1 : 0) | (x.externalPower ? 2 : 0) | (x.low ? 4 : 0) | (x.critical ? 8 : 0))
            b.append(UInt8(bitPattern: x.temperatureC ?? Int8.min))
        case .error(let r, let a): b.append(r.rawValue); try fixed(a, 16)
        }
        guard b.count <= maxMessageLength else { throw CodecError.tooLong }
        return b
    }

    // MARK: decode

    public static func decode(_ bytes: [UInt8]) throws -> (Header, Message) {
        guard bytes.count >= headerLength else { throw CodecError.truncated }
        guard bytes.count <= maxMessageLength else { throw CodecError.tooLong }
        let h = Header(messageID: UInt16(bytes[1]) << 8 | UInt16(bytes[2]), session: UInt16(bytes[3]) << 8 | UInt16(bytes[4]))
        var i = headerLength
        func take(_ n: Int) throws -> [UInt8] { guard i + n <= bytes.count else { throw CodecError.badBody }; defer { i += n }; return Array(bytes[i..<i + n]) }
        func u8() throws -> UInt8 { try take(1)[0] }
        func u16() throws -> UInt16 { let t = try take(2); return UInt16(t[0]) << 8 | UInt16(t[1]) }
        func reason() throws -> Reason { guard let r = Reason(rawValue: try u8()) else { throw CodecError.badBody }; return r }
        func str8() throws -> String { guard let s = String(bytes: try take(Int(try u8())), encoding: .utf8) else { throw CodecError.badBody }; return s }
        let m: Message
        switch bytes[0] {
        case 0x01:
            guard let k = HandshakeKind(rawValue: try u8()) else { throw CodecError.badBody }
            let p = try u8()
            m = .handshake(kind: k, protocolVersion: p, nonce: try take(16), proof: try take(32))
        case 0x02: m = .heartbeat(counter: try take(4).reduce(0) { $0 << 8 | UInt32($1) })
        case 0x03:
            let a = try take(16), amt = try take(8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            guard let cur = String(bytes: try take(3), encoding: .ascii) else { throw CodecError.badBody }
            m = .beginPayment(attempt: a, amountCents: amt, currency: cur, timeoutSeconds: try u8())
        case 0x04:
            guard let p = Purpose(rawValue: try u8()) else { throw CodecError.badBody }
            m = .beginRead(purpose: p, attempt: try take(16), timeoutSeconds: try u8())
        case 0x05: m = .cancel(attempt: try take(16))
        case 0x06:
            let a = try take(16)
            guard let o = PaymentOutcome(rawValue: try u8()) else { throw CodecError.badBody }
            m = .paymentStatus(attempt: a, outcome: o)
        case 0x07: m = .getStatus
        case 0x08: m = .configure(volume: try u8(), muted: try u8() != 0)
        case 0x09:
            guard let mode = LightMode(rawValue: try u8()) else { throw CodecError.badBody }
            m = .setLightMode(mode, durationSeconds: try u16())
        case 0x0A: m = .eventAck(of: try u16())
        case 0x81:
            let uid = try take(6), nonce = try take(16), p = try u8(), cap = try u16()
            m = .hello(uid: uid, model: try str8(), firmware: try str8(), protocolVersion: p, capabilities: cap, nonce: nonce)
        case 0x82: m = .handshakeResult(accepted: try u8() != 0, reason: try reason(), proof: try take(32))
        case 0x83: m = .commandAck(of: try u16(), accepted: try u8() != 0, reason: try reason())
        case 0x84:
            guard let s = State(rawValue: try u8()) else { throw CodecError.badBody }
            m = .stateChanged(s)
        case 0x85:
            guard let p = Purpose(rawValue: try u8()) else { throw CodecError.badBody }
            let a = try take(16)
            guard let url = String(bytes: bytes[i...], encoding: .utf8) else { throw CodecError.badBody }
            i = bytes.count
            m = .tapCaptured(purpose: p, attempt: a, url: url)
        case 0x86:
            let p = try u8(), mv = try u16(), f = try u8(), t = Int8(bitPattern: try u8())
            m = .battery(Battery(percent: p == 0xFF ? nil : p, millivolts: mv, charging: f & 1 != 0, externalPower: f & 2 != 0,
                                 low: f & 4 != 0, critical: f & 8 != 0, temperatureC: t == Int8.min ? nil : t))
        case 0x87: m = .error(reason: try reason(), attempt: try take(16))
        case let other: throw CodecError.unknownOpcode(other)
        }
        guard i == bytes.count else { throw CodecError.badBody }
        return (h, m)
    }

    // MARK: fragmentation

    public enum FragmentError: Error, Equatable { case capacityTooSmall, messageTooLong, malformed, outOfOrder, overflow }

    /// Splits a message into BLE-sized fragments. `capacity` is the usable bytes of one write (ATT MTU - 3).
    public static func fragments(of message: [UInt8], messageID: UInt16, capacity: Int) throws -> [[UInt8]] {
        guard capacity > fragmentHeaderLength else { throw FragmentError.capacityTooSmall }
        guard message.count <= maxMessageLength else { throw FragmentError.messageTooLong }
        let chunk = capacity - fragmentHeaderLength
        let count = max(1, (message.count + chunk - 1) / chunk)
        guard count <= 256 else { throw FragmentError.capacityTooSmall }
        return (0..<count).map { n in
            let lo = n * chunk, hi = min(message.count, lo + chunk)
            let flags: UInt8 = (n == 0 ? 1 : 0) | (n == count - 1 ? 2 : 0)
            return [flags, UInt8(messageID >> 8), UInt8(messageID & 0xFF), UInt8(n)] + message[lo..<hi]
        }
    }

    /// Puts fragments back together; one partial message at a time, duplicates ignored, stalls dropped.
    public struct Reassembler {
        private var buf = [UInt8](), id: UInt16 = 0, next: UInt8 = 0, receiving = false, lastActivity: TimeInterval = 0, lastDone: UInt16?
        public var timeout: TimeInterval = 2
        public init() {}

        public mutating func push(_ f: [UInt8], now: TimeInterval) throws -> (id: UInt16, message: [UInt8])? {
            if receiving && now - lastActivity >= timeout { reset() }
            guard f.count >= fragmentHeaderLength, f[0] & ~3 == 0 else { throw FragmentError.malformed }
            let flags = f[0], fid = UInt16(f[1]) << 8 | UInt16(f[2]), index = f[3]
            if flags & 1 != 0 {
                guard index == 0 else { throw FragmentError.malformed }
                if lastDone == fid || (receiving && id == fid) { return nil }
                reset(); receiving = true; id = fid
            } else {
                guard receiving else { if lastDone == fid { return nil }; throw FragmentError.outOfOrder }
                guard fid == id else { reset(); throw FragmentError.outOfOrder }
                if index &+ 1 == next { return nil }
                guard index == next else { reset(); throw FragmentError.outOfOrder }
            }
            guard buf.count + f.count - fragmentHeaderLength <= maxMessageLength else { reset(); throw FragmentError.overflow }
            buf += f[fragmentHeaderLength...]
            next = index &+ 1; lastActivity = now
            if flags & 2 != 0 {
                receiving = false; lastDone = id
                defer { buf = [] }
                return (id, buf)
            }
            return nil
        }
        private mutating func reset() { buf = []; receiving = false; next = 0 }
    }
}
