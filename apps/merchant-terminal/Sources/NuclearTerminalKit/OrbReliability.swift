import Foundation

/// Reliable delivery over the Orb's BLE link (docs/ORB.md section 6); the firmware side is `../orb-firmware/src/outbox.rs`.
///
/// * Orb events that must arrive (StateChanged, TapCaptured, Error) are resent by the Orb, byte for byte with the same message id, until
///   the terminal answers `EventAck`. `OrbEventReceiver` makes the terminal's half: acknowledge every such event (a duplicate too, so the
///   Orb stops) and deliver each one to the app only once.
/// * Terminal commands are resent the same way until the Orb answers `CommandAck`. `OrbRetransmitQueue` does that, with the same timing as
///   the firmware's `ACK_TIMEOUT_MS` and `MAX_RETRIES`.
extension OrbV1 {
    /// Events the Orb must be sure the terminal received.
    public static func isReliableEvent(_ m: Message) -> Bool {
        switch m {
        case .stateChanged, .tapCaptured, .error: return true
        default: return false
        }
    }

    /// Terminal side of event delivery: de-duplicates by the Orb's message id and builds the acknowledgements.
    public struct EventReceiver {
        /// Ids remembered (the Orb never has more than a handful in flight; a few dozen is ample).
        public static let memory = 32
        private var seen = [UInt16]()
        private var nextID: UInt16

        public init(firstMessageID: UInt16 = 1) { nextID = firstMessageID }

        public struct Result: Equatable {
            /// False for a resend of an event already delivered: do not act on it again.
            public let deliver: Bool
            /// The encoded `EventAck` to send back, or nil for messages that are not reliable events.
            public let ack: [UInt8]?
        }

        public mutating func receive(_ header: Header, _ message: Message) throws -> Result {
            guard isReliableEvent(message) else { return Result(deliver: true, ack: nil) }
            let fresh = !seen.contains(header.messageID)
            if fresh {
                seen.append(header.messageID)
                if seen.count > Self.memory { seen.removeFirst() }
            }
            let id = nextID
            nextID = nextID &+ 1
            let ack = try encode(.eventAck(of: header.messageID), Header(messageID: id, session: header.session))
            return Result(deliver: fresh, ack: ack)
        }

        /// A new session starts with a fresh state report: forget the old session's ids.
        public mutating func reset() { seen = [] }
    }

    /// Terminal side of command delivery: remembers each sent command until the Orb's `CommandAck`, and resends it unchanged when it is late.
    public struct RetransmitQueue {
        public static let ackTimeout: TimeInterval = 1.5
        public static let maxRetries = 3

        public enum Delivery: Equatable {
            case send(messageID: UInt16, bytes: [UInt8])
            case gaveUp(messageID: UInt16)
        }

        private struct Entry { let id: UInt16; let bytes: [UInt8]; var sentAt: TimeInterval?; var resends = 0 }
        private var entries = [Entry]()

        public init() {}
        public var pending: Int { entries.count }

        public mutating func add(messageID: UInt16, bytes: [UInt8]) { entries.append(Entry(id: messageID, bytes: bytes, sentAt: nil)) }

        /// The Orb answered this command. False when it was not waiting (a duplicate or unknown ack).
        @discardableResult public mutating func ack(of id: UInt16) -> Bool {
            guard let i = entries.firstIndex(where: { $0.id == id }) else { return false }
            entries.remove(at: i)
            return true
        }

        /// Everything to do at `now`, oldest first: first sends, resends of late commands, and commands given up on.
        public mutating func due(now: TimeInterval) -> [Delivery] {
            var out = [Delivery]()
            var keep = [Entry]()
            for var e in entries {
                if let sent = e.sentAt {
                    guard now - sent >= Self.ackTimeout else { keep.append(e); continue }
                    if e.resends >= Self.maxRetries { out.append(.gaveUp(messageID: e.id)); continue }
                    e.resends += 1
                }
                e.sentAt = now
                out.append(.send(messageID: e.id, bytes: e.bytes))
                keep.append(e)
            }
            entries = keep
            return out
        }

        public mutating func removeAll() { entries = [] }
    }
}
