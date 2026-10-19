import XCTest
@testable import NuclearTerminalKit

/// Answers every request from a closure, so the client is tested without a network.
final class MockProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = MockProtocol.handler!(request)
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class NuclearTerminalKitTests: XCTestCase {
    func client() -> TerminalClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [MockProtocol.self]
        return TerminalClient(baseURL: URL(string: "https://api.example.test")!, token: "tok", session: URLSession(configuration: cfg))
    }

    func testMoneyFormatAndParse() {
        XCTAssertEqual(Money.format(cents: 12999), "$129.99")
        XCTAssertEqual(Money.format(cents: 5), "$0.05")
        XCTAssertEqual(Money.format(cents: -500), "-$5.00")
        XCTAssertEqual(Money.format(cents: 123_456_789), "$1,234,567.89")
        XCTAssertEqual(Money.parse("4.50"), 450)
        XCTAssertEqual(Money.parse("4"), 400)
        XCTAssertEqual(Money.parse("0.5"), 50)
        XCTAssertNil(Money.parse("4.505"))
        XCTAssertNil(Money.parse("-1"))
        XCTAssertNil(Money.parse("1e3"))
        XCTAssertNil(Money.parse(""))
    }

    func testPaySendsTheTapWithTheAttemptAsIdempotencyKey() async throws {
        var seen: URLRequest?
        MockProtocol.handler = { req in seen = req; return (201, #"{"payment":{"id":"p1","status":"completed","amount":1200}}"#) }
        let r = try await client().pay(checkoutId: "co1", tapURL: "https://tag.example/v1/abc", attemptId: "attempt-1")
        XCTAssertEqual(r.status, "completed")
        XCTAssertEqual(seen?.httpMethod, "POST")
        XCTAssertEqual(seen?.url?.path, "/v1/terminal/payments")
        XCTAssertEqual(seen?.value(forHTTPHeaderField: "Idempotency-Key"), "attempt-1")
        XCTAssertEqual(seen?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
    }

    func testADeclineIsAResultNotAnError() async throws {
        MockProtocol.handler = { _ in (422, #"{"error":"declined","status_code":"insufficient_balance","payment":{"id":"p2","status":"failed","status_code":"insufficient_balance"}}"#) }
        let r = try await client().pay(checkoutId: "co1", tapURL: "u", attemptId: "a")
        XCTAssertEqual(r.status, "failed")
        XCTAssertEqual(r.statusCode, "insufficient_balance")
    }

    func testTransportAndSessionErrors() async {
        MockProtocol.handler = { _ in (401, #"{"error":"unauthorized"}"#) }
        do { _ = try await client().products(); XCTFail("should throw") } catch let e as APIError {
            XCTAssertEqual(e.code, "unauthorized"); XCTAssertTrue(e.sessionEnded)
        } catch { XCTFail("wrong error \(error)") }
    }

    func testProductsDecode() async throws {
        MockProtocol.handler = { _ in (200, #"{"products":[{"id":"p","category_id":null,"name":"Latte","currency":"USD","price":450,"discount":50,"effective_price":400,"photo":null,"stock":9,"active":true,"status":"available"}]}"#) }
        let list = try await client().products()
        XCTAssertEqual(list.first?.effectivePrice, 400)
        XCTAssertEqual(list.first?.name, "Latte")
    }

    func testRefundBodyMatchesTheAPI() async throws {
        var body: [String: Any]?
        MockProtocol.handler = { req in
            let data = req.httpBody ?? req.httpBodyStream.flatMap { s -> Data in
                s.open(); defer { s.close() }
                var d = Data(); var buf = [UInt8](repeating: 0, count: 1024)
                while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
                return d
            }
            body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            return (202, #"{"refund":{"id":"r1","status":"pending","status_code":"awaiting_approval"}}"#)
        }
        let (status, _) = try await client().refund(paymentAttemptId: "att", mode: .items([RefundLine(checkoutItemId: "i1", quantity: 2)], restock: true), tapURL: nil, attemptId: "ref-1")
        XCTAssertEqual(status, 202)
        XCTAssertEqual(body?["attempt"] as? String, "att")
        XCTAssertEqual(body?["mode"] as? String, "items")
        XCTAssertEqual(body?["restock"] as? Bool, true)
        XCTAssertNil(body?["approval"])
    }

    func testOrbFramesRoundTrip() throws {
        let frames: [OrbFrame] = [
            .hello(uid: [0xAA, 0xBB, 0xCC, 0x00, 0x11, 0x22], model: "Orb 2", firmware: "1.4.2"),
            .readRequest(timeoutSeconds: 30), .cancel, .tapRead(url: "https://tag.example/v1/0123456789abcdef0123456789abcdef"),
            .failure(.noTag), .ping, .pong,
        ]
        for f in frames { XCTAssertEqual(try OrbFrame(bytes: try f.encoded()), f) }
        XCTAssertThrowsError(try OrbFrame(bytes: [0x20, 5, 1, 2]))                     // truncated
        XCTAssertThrowsError(try OrbFrame(bytes: [0x99, 0]))                            // unknown type
        XCTAssertThrowsError(try OrbFrame.tapRead(url: String(repeating: "x", count: 63)).encoded())   // too long
        XCTAssertEqual(try OrbFrame.readRequest(timeoutSeconds: 5).encoded(), [0x10, 1, 5])
    }

    // MARK: Orb protocol v1 (golden vectors are the same bytes asserted in orb-firmware/src/message.rs)

    func testOrbV1GoldenVectors() throws {
        XCTAssertEqual(try OrbV1.encode(.heartbeat(counter: 1), .init(messageID: 1, session: 2)), [0x02, 0, 1, 0, 2, 0, 0, 0, 1])
        XCTAssertEqual(try OrbV1.encode(.beginPayment(attempt: [UInt8](repeating: 0xAA, count: 16), amountCents: 1250, currency: "USD", timeoutSeconds: 30),
                                        .init(messageID: 0x10, session: 3)),
                       [0x03, 0, 0x10, 0, 3] + [UInt8](repeating: 0xAA, count: 16) + [0, 0, 0, 0, 0, 0, 0x04, 0xE2, 0x55, 0x53, 0x44, 30])
        XCTAssertEqual(try OrbV1.encode(.stateChanged(.connectedIdle), .init(messageID: 5, session: 1)), [0x84, 0, 5, 0, 1, 3])
    }

    func testOrbV1EveryMessageRoundTrips() throws {
        let a = OrbV1.attemptID(UUID())
        let msgs: [OrbV1.Message] = [
            .handshake(kind: .bind, protocolVersion: 1, nonce: [UInt8](repeating: 7, count: 16), proof: [UInt8](repeating: 9, count: 32)),
            .heartbeat(counter: 0xDEADBEEF), .beginPayment(attempt: a, amountCents: 12_999, currency: "USD", timeoutSeconds: 30),
            .beginRead(purpose: .lookup, attempt: a, timeoutSeconds: 0), .cancel(attempt: a), .paymentStatus(attempt: a, outcome: .completed),
            .getStatus, .configure(volume: 70, muted: true), .setLightMode(.emergency, durationSeconds: 600),
            .hello(uid: [1, 2, 3, 4, 5, 6], model: "Orb 1", firmware: "0.1.0", protocolVersion: 1, capabilities: 3),
            .handshakeResult(accepted: false, reason: .proximityNotMet), .commandAck(of: 77, accepted: true, reason: .ok),
            .stateChanged(.awaitingPayment), .tapCaptured(purpose: .payment, attempt: a, url: "https://tag.example/v1/0123456789abcdef"),
            .battery(.init(percent: 83, millivolts: 3987, charging: true, externalPower: true, low: false, critical: false, temperatureC: 24)),
            .battery(.init(percent: nil, millivolts: 3300, charging: false, externalPower: false, low: true, critical: true, temperatureC: nil)),
            .error(reason: .timeout, attempt: a),
        ]
        let h = OrbV1.Header(messageID: 0x0102, session: 0x0304)
        for m in msgs {
            let (rh, rm) = try OrbV1.decode(try OrbV1.encode(m, h))
            XCTAssertEqual(rh, h); XCTAssertEqual(rm, m)
        }
    }

    func testOrbV1BadInputIsRefused() {
        XCTAssertThrowsError(try OrbV1.decode([0x02, 0, 1]))
        XCTAssertThrowsError(try OrbV1.decode([0x55, 0, 1, 0, 1]))
        XCTAssertThrowsError(try OrbV1.decode([0x07, 0, 1, 0, 1, 9]))      // trailing byte
        XCTAssertThrowsError(try OrbV1.decode([0x84, 0, 1, 0, 1, 99]))     // unknown state
    }

    func testOrbV1FragmentsRoundTripAtAnyCapacity() throws {
        let url = "https://tag.example/v1/" + String(repeating: "a", count: 120)
        let msg = try OrbV1.encode(.tapCaptured(purpose: .payment, attempt: OrbV1.attemptID(UUID()), url: url), .init(messageID: 9, session: 1))
        for cap in [5, 20, 64, 185] {
            var r = OrbV1.Reassembler(), out: (id: UInt16, message: [UInt8])?
            for f in try OrbV1.fragments(of: msg, messageID: 9, capacity: cap) { out = try r.push(f, now: 0) ?? out }
            XCTAssertEqual(out?.message, msg)
        }
        XCTAssertThrowsError(try OrbV1.fragments(of: msg, messageID: 9, capacity: 4))
    }

    func testOrbV1ReassemblerIgnoresDuplicatesAndRejectsGaps() throws {
        let msg = [UInt8](0..<40)
        let fr = try OrbV1.fragments(of: msg, messageID: 3, capacity: 14)           // 10-byte chunks, 4 fragments
        var r = OrbV1.Reassembler()
        XCTAssertNil(try r.push(fr[0], now: 0)); XCTAssertNil(try r.push(fr[0], now: 0)); XCTAssertNil(try r.push(fr[1], now: 0))
        XCTAssertNil(try r.push(fr[1], now: 0)); XCTAssertNil(try r.push(fr[2], now: 0))
        XCTAssertEqual(try r.push(fr[3], now: 0)?.message, msg)
        XCTAssertNil(try r.push(fr[0], now: 0))                                       // retransmitted whole message
        var g = OrbV1.Reassembler()
        _ = try g.push(fr[0], now: 0)
        XCTAssertThrowsError(try g.push(fr[2], now: 0))                               // gap
    }

    func testOrbV1StalledMessageExpires() throws {
        let fr = try OrbV1.fragments(of: [UInt8](0..<40), messageID: 4, capacity: 14)
        var r = OrbV1.Reassembler()
        _ = try r.push(fr[0], now: 0)
        XCTAssertThrowsError(try r.push(fr[1], now: 5))                               // dropped after the timeout, so a middle fragment is a stray
    }
}
