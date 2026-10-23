import CryptoKit
import Foundation

/// The terminal's side of the Orb secure channel (docs/ORB.md §8a); the Rust mirror is `apps/orb-firmware/src/secure.rs` and both are
/// tested against the same vectors. HMAC-SHA256 is the PRF; frames are ChaCha20-Poly1305 with a strictly increasing counter.
public enum OrbSecure {
    public enum ChannelError: Error, Equatable { case length, replay, auth, exhausted }

    /// `HMAC-SHA256(key, label || 0x00 || parts...)`.
    public static func prf(_ key: [UInt8], _ label: String, _ parts: [UInt8]...) -> [UInt8] {
        var m = HMAC<SHA256>(key: SymmetricKey(data: key))
        m.update(data: Array(label.utf8) + [0])
        for p in parts { m.update(data: p) }
        return Array(m.finalize())
    }

    /// `K_bind` once the API has authorized the bind (the API sends `bindKey`; the terminal never sees `K_orb`).
    public static func terminalProof(kBind: [UInt8], nonceO: [UInt8], nonceT: [UInt8]) -> [UInt8] {
        prf(kBind, "term-proof-v1", nonceO, nonceT)
    }

    /// What the Orb must answer in `HandshakeResult.proof` after a Bind or a Resume; compare with `constantTimeEqual`.
    public static func expectedOrbProofForBind(kBind: [UInt8], nonceO: [UInt8], bindingId: [UInt8]) -> [UInt8] {
        prf(kBind, "orb-proof-v1", nonceO, bindingId)
    }
    public static func expectedOrbProofForResume(kBind: [UInt8], nonceO: [UInt8], nonceT: [UInt8]) -> [UInt8] {
        prf(kBind, "orb-resume-v1", nonceO, nonceT)
    }

    public static func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var d: UInt8 = 0
        for i in 0..<a.count { d |= a[i] ^ b[i] }
        return d == 0
    }

    /// Frames for one session: counter (8, big-endian) || ciphertext || tag (16). Counters start at 1; a frame that fails
    /// authentication does not advance the receive counter.
    public struct Channel {
        public static let overhead = 8 + 16
        private let sendKey: SymmetricKey, recvKey: SymmetricKey
        private let aad: [UInt8]
        private var sendCounter: UInt64 = 0, recvCounter: UInt64 = 0

        public init(kBind: [UInt8], nonceO: [UInt8], bindingId: [UInt8], generation: UInt16) {
            let gen = [UInt8(generation >> 8), UInt8(generation & 0xFF)]
            sendKey = SymmetricKey(data: OrbSecure.prf(kBind, "session-t2o-v1", nonceO, bindingId, gen))
            recvKey = SymmetricKey(data: OrbSecure.prf(kBind, "session-o2t-v1", nonceO, bindingId, gen))
            aad = [1] + gen
        }

        private static func nonce(_ ctr: UInt64) throws -> ChaChaPoly.Nonce {
            try ChaChaPoly.Nonce(data: [UInt8](repeating: 0, count: 4) + (0..<8).map { UInt8((ctr >> UInt64(56 - 8 * $0)) & 0xFF) })
        }

        public mutating func seal(_ plain: [UInt8]) throws -> [UInt8] {
            guard sendCounter < UInt64.max else { throw ChannelError.exhausted }
            let ctr = sendCounter + 1
            let box = try ChaChaPoly.seal(Data(plain), using: sendKey, nonce: Self.nonce(ctr), authenticating: Data(aad))
            sendCounter = ctr
            return (0..<8).map { UInt8((ctr >> UInt64(56 - 8 * $0)) & 0xFF) } + Array(box.ciphertext) + Array(box.tag)
        }

        public mutating func open(_ frame: [UInt8]) throws -> [UInt8] {
            guard frame.count >= Self.overhead else { throw ChannelError.length }
            let ctr = frame[0..<8].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            guard ctr > recvCounter else { throw ChannelError.replay }
            let n = frame.count - Self.overhead
            do {
                let box = try ChaChaPoly.SealedBox(nonce: Self.nonce(ctr), ciphertext: Data(frame[8..<(8 + n)]), tag: Data(frame[(8 + n)...]))
                let plain = try ChaChaPoly.open(box, using: recvKey, authenticating: Data(aad))
                recvCounter = ctr
                return Array(plain)
            } catch { throw ChannelError.auth }
        }
    }
}
