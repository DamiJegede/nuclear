import Foundation

/// The Bluetooth LE frame format between this app and the Orb. `../orb-firmware/src/protocol.rs` implements the same format; keep them in step.
///
///     | type: u8 | length: u8 | payload: length bytes |
///
/// One frame per BLE write or notification (the link MTU is negotiated to at least 64 bytes, so a frame is at most 2 + 62 bytes).
/// Multi-byte numbers are big-endian; strings are UTF-8 without a terminator.
public enum OrbFrame: Equatable {
    /// Orb -> app, right after connecting: the 6-byte MAC address, the model name and the firmware version.
    case hello(uid: [UInt8], model: String, firmware: String)
    /// App -> Orb: start listening for a tap. `timeoutSeconds` 0 means until cancelled.
    case readRequest(timeoutSeconds: UInt8)
    /// App -> Orb: stop listening.
    case cancel
    /// Orb -> app: a tag was tapped; the NDEF URL the tag's secure messaging produced (the app sends it to the API as the tap credential).
    case tapRead(url: String)
    /// Orb -> app: the tap could not be read (see `OrbError`).
    case failure(OrbError)
    /// Either direction: keep-alive.
    case ping
    case pong

    public enum OrbError: UInt8, Equatable {
        case timeout = 1, noTag = 2, unreadable = 3, busy = 4, unsupportedTag = 5
    }

    public enum ParseError: Error, Equatable { case truncated, unknownType(UInt8), badPayload, tooLong }

    static let helloType: UInt8 = 0x01, readRequestType: UInt8 = 0x10, cancelType: UInt8 = 0x11, tapReadType: UInt8 = 0x20
    static let failureType: UInt8 = 0x7F, pingType: UInt8 = 0xF0, pongType: UInt8 = 0xF1
    /// The largest payload a frame may carry.
    public static let maxPayload = 62

    public func encoded() throws -> [UInt8] {
        let (type, payload): (UInt8, [UInt8])
        switch self {
        case .hello(let uid, let model, let firmware):
            let m = Array(model.utf8), f = Array(firmware.utf8)
            guard uid.count == 6, m.count < 256, f.count < 256 else { throw ParseError.badPayload }
            (type, payload) = (OrbFrame.helloType, uid + [UInt8(m.count)] + m + [UInt8(f.count)] + f)
        case .readRequest(let t): (type, payload) = (OrbFrame.readRequestType, [t])
        case .cancel: (type, payload) = (OrbFrame.cancelType, [])
        case .tapRead(let url): (type, payload) = (OrbFrame.tapReadType, Array(url.utf8))
        case .failure(let e): (type, payload) = (OrbFrame.failureType, [e.rawValue])
        case .ping: (type, payload) = (OrbFrame.pingType, [])
        case .pong: (type, payload) = (OrbFrame.pongType, [])
        }
        guard payload.count <= OrbFrame.maxPayload else { throw ParseError.tooLong }
        return [type, UInt8(payload.count)] + payload
    }

    public init(bytes: [UInt8]) throws {
        guard bytes.count >= 2 else { throw ParseError.truncated }
        let type = bytes[0], len = Int(bytes[1])
        guard len <= OrbFrame.maxPayload else { throw ParseError.tooLong }
        guard bytes.count >= 2 + len else { throw ParseError.truncated }
        let p = Array(bytes[2..<(2 + len)])
        switch type {
        case OrbFrame.helloType:
            guard p.count >= 8 else { throw ParseError.badPayload }
            let uid = Array(p[0..<6]); let mLen = Int(p[6])
            guard p.count >= 7 + mLen + 1 else { throw ParseError.badPayload }
            let model = String(decoding: p[7..<(7 + mLen)], as: UTF8.self)
            let fLen = Int(p[7 + mLen])
            guard p.count == 8 + mLen + fLen else { throw ParseError.badPayload }
            self = .hello(uid: uid, model: model, firmware: String(decoding: p[(8 + mLen)...], as: UTF8.self))
        case OrbFrame.readRequestType:
            guard p.count == 1 else { throw ParseError.badPayload }
            self = .readRequest(timeoutSeconds: p[0])
        case OrbFrame.cancelType: self = .cancel
        case OrbFrame.tapReadType: self = .tapRead(url: String(decoding: p, as: UTF8.self))
        case OrbFrame.failureType:
            guard p.count == 1, let e = OrbError(rawValue: p[0]) else { throw ParseError.badPayload }
            self = .failure(e)
        case OrbFrame.pingType: self = .ping
        case OrbFrame.pongType: self = .pong
        default: throw ParseError.unknownType(type)
        }
    }
}
