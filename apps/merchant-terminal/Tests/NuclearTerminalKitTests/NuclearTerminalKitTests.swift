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

    func bodyOf(_ req: URLRequest) -> [String: Any]? {
        let data = req.httpBody ?? req.httpBodyStream.flatMap { s -> Data in
            s.open(); defer { s.close() }
            var d = Data(); var buf = [UInt8](repeating: 0, count: 1024)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            return d
        }
        return data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    func testPayCarriesTheTipAndWhoServed() async throws {
        var body: [String: Any]?
        MockProtocol.handler = { req in body = self.bodyOf(req); return (201, #"{"payment":{"id":"p1","status":"completed","amount":1500,"tip_amount":300,"served_by":"acct-rae"}}"#) }
        let r = try await client().pay(checkoutId: "co1", tapURL: "u", attemptId: "a", tipCents: 300, servedBy: "staff-rae")
        XCTAssertEqual(body?["tip"] as? Int, 300)
        XCTAssertEqual(body?["served_by"] as? String, "staff-rae")
        XCTAssertNil(body?["tips"])
        XCTAssertEqual(r.tipAmount, 300)
        XCTAssertEqual(r.servedBy, "acct-rae")
        XCTAssertEqual(r.amount, 1500)
    }

    func testAPaymentWithoutATipSendsNoTipFields() async throws {
        var body: [String: Any]?
        MockProtocol.handler = { req in body = self.bodyOf(req); return (201, #"{"payment":{"id":"p1","status":"completed","amount":1200}}"#) }
        let r = try await client().pay(checkoutId: "co1", tapURL: "u", attemptId: "a")
        XCTAssertNil(body?["tip"]); XCTAssertNil(body?["tips"]); XCTAssertNil(body?["served_by"])
        XCTAssertNil(r.tipAmount)
    }

    func testATipSplitsByAmounts() async throws {
        var body: [String: Any]?
        MockProtocol.handler = { req in body = self.bodyOf(req); return (201, #"{"payment":{"id":"p1","status":"completed","amount":3250,"tip_amount":250}}"#) }
        _ = try await client().pay(checkoutId: "co1", tapURL: "u", attemptId: "a", tipCents: 250, tips: [TipShare(staffId: "s1", amountCents: 150), TipShare(staffId: "s2", amountCents: 100)])
        let shares = body?["tips"] as? [[String: Any]]
        XCTAssertEqual(shares?.map { $0["staff_id"] as? String }, ["s1", "s2"])
        XCTAssertEqual(shares?.map { $0["amount"] as? Int }, [150, 100])
    }

    func testACheckoutCarriesWhoServesIt() async throws {
        var body: [String: Any]?
        MockProtocol.handler = { req in body = self.bodyOf(req); return (201, #"{"checkout":{"id":"c1","status":"open","reference":null,"total":4000,"items":[],"tip_amount":0,"served_by":"acct-sam"}}"#) }
        let c = try await client().createCheckout(amountCents: 4000, servedBy: "staff-sam")
        XCTAssertEqual(body?["served_by"] as? String, "staff-sam")
        XCTAssertEqual(c.servedBy, "acct-sam")
        XCTAssertEqual(c.tipAmount, 0)
    }

    func testStaffListAndActiveStaff() async throws {
        var seen: [(String, String, [String: Any]?)] = []
        MockProtocol.handler = { req in
            seen.append((req.httpMethod ?? "", req.url?.path ?? "", self.bodyOf(req)))
            if req.httpMethod == "GET" { return (200, #"{"staff":[{"id":"s1","staff_account_id":"a1","name":"Rae","handle":null,"role":"read"}],"active_staff_id":"s1"}"#) }
            return (200, #"{"active_staff_id":null}"#)
        }
        let list = try await client().staff()
        XCTAssertEqual(list.staff.first?.name, "Rae")
        XCTAssertEqual(list.activeStaffId, "s1")
        try await client().setActiveStaff(nil)
        try await client().setActiveStaff("s1")
        XCTAssertEqual(seen[1].1, "/v1/terminal/active-staff")
        XCTAssertTrue(seen[1].2?["staff_id"] is NSNull)
        XCTAssertEqual(seen[2].2?["staff_id"] as? String, "s1")
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

    func testCloseOutSendsTheStaffTapAndDecodesTheSettlement() async throws {
        var path: String?, body: [String: Any]?
        MockProtocol.handler = { req in
            path = req.url?.path
            let data = req.httpBody ?? req.httpBodyStream.flatMap { s -> Data in
                s.open(); defer { s.close() }
                var d = Data(); var buf = [UInt8](repeating: 0, count: 1024)
                while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
                return d
            }
            body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            return (201, #"{"settlement":{"id":"s1","date":"2026-10-28","amount":1500,"rail":"instant","status":"completed","arrival":"instant"}}"#)
        }
        let r = try await client().closeOut(tapURL: "https://tag.nclr.app/v1/abc")
        XCTAssertEqual(path, "/v1/terminal/close-out")
        XCTAssertEqual(((body?["approval"] as? [String: Any])?["credential"] as? [String: Any])?["url"] as? String, "https://tag.nclr.app/v1/abc")
        XCTAssertEqual(r, CloseOut(id: "s1", date: "2026-10-28", amount: 1500, rail: "instant", status: "completed", arrival: "instant"))
    }

    func testCloseOutRefusedForNonWriteStaff() async throws {
        MockProtocol.handler = { _ in (403, #"{"error":"approver_not_authorized"}"#) }
        do { _ = try await client().closeOut(tapURL: "x"); XCTFail("should throw") } catch let e as APIError { XCTAssertEqual(e.code, "approver_not_authorized") }
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

    func testOrbV1EventAckGoldenVector() throws {
        XCTAssertEqual(try OrbV1.encode(.eventAck(of: 0x0102), .init(messageID: 7, session: 3)), [0x0A, 0, 7, 0, 3, 0x01, 0x02])
        XCTAssertEqual(try OrbV1.decode([0x0A, 0, 7, 0, 3, 0x01, 0x02]).1, .eventAck(of: 0x0102))
        XCTAssertThrowsError(try OrbV1.decode([0x0A, 0, 7, 0, 3, 0x01]))                  // truncated body
    }

    func testEventReceiverAcknowledgesEveryReliableEventAndDeliversOnce() throws {
        var r = OrbV1.EventReceiver(firstMessageID: 100)
        let h = OrbV1.Header(messageID: 0x0102, session: 3)
        let first = try r.receive(h, .stateChanged(.completed))
        XCTAssertTrue(first.deliver)
        XCTAssertEqual(try OrbV1.decode(first.ack!).1, .eventAck(of: 0x0102))
        XCTAssertEqual(try OrbV1.decode(first.ack!).0.session, 3)
        let resend = try r.receive(h, .stateChanged(.completed))                           // the Orb did not hear our ack
        XCTAssertFalse(resend.deliver)
        XCTAssertNotNil(resend.ack)                                                        // still acknowledged, so the Orb stops
        XCTAssertNotEqual(first.ack, resend.ack)                                           // each ack has its own message id
        let plain = try r.receive(.init(messageID: 5, session: 3), .battery(.init(percent: 50, millivolts: 3900, charging: false, externalPower: false, low: false, critical: false, temperatureC: nil)))
        XCTAssertTrue(plain.deliver)
        XCTAssertNil(plain.ack)                                                            // telemetry is not acknowledged
    }

    func testEventReceiverCoversTapsAndErrorsAndForgetsOnReset() throws {
        var r = OrbV1.EventReceiver()
        let tap = OrbV1.Message.tapCaptured(purpose: .payment, attempt: OrbV1.attemptID(UUID()), url: "https://x.example/v1/abc")
        XCTAssertTrue(try r.receive(.init(messageID: 9, session: 1), tap).deliver)
        XCTAssertFalse(try r.receive(.init(messageID: 9, session: 1), tap).deliver)
        XCTAssertNotNil(try r.receive(.init(messageID: 10, session: 1), .error(reason: .timeout, attempt: OrbV1.attemptID(UUID()))).ack)
        r.reset()
        XCTAssertTrue(try r.receive(.init(messageID: 9, session: 2), tap).deliver)          // a new session reuses ids
    }

    func testEventReceiverMemoryIsBounded() throws {
        var r = OrbV1.EventReceiver()
        for id in 1...UInt16(OrbV1.EventReceiver.memory + 5) { _ = try r.receive(.init(messageID: id, session: 1), .stateChanged(.connectedIdle)) }
        XCTAssertTrue(try r.receive(.init(messageID: 1, session: 1), .stateChanged(.connectedIdle)).deliver)    // the oldest id was forgotten
        XCTAssertFalse(try r.receive(.init(messageID: UInt16(OrbV1.EventReceiver.memory + 5), session: 1), .stateChanged(.connectedIdle)).deliver)
    }

    func testRetransmitQueueResendsUntilAckedThenGivesUp() {
        var q = OrbV1.RetransmitQueue()
        q.add(messageID: 7, bytes: [1, 2, 3])
        XCTAssertEqual(q.due(now: 0), [.send(messageID: 7, bytes: [1, 2, 3])])
        XCTAssertEqual(q.due(now: 1.0), [])
        XCTAssertEqual(q.due(now: 1.5), [.send(messageID: 7, bytes: [1, 2, 3])])           // same id, same bytes
        XCTAssertTrue(q.ack(of: 7))
        XCTAssertFalse(q.ack(of: 7))
        XCTAssertEqual(q.pending, 0)
        XCTAssertEqual(q.due(now: 100), [])

        q.add(messageID: 8, bytes: [9])
        var sends = 0, now = 0.0
        while true {
            let d = q.due(now: now)
            if d == [.gaveUp(messageID: 8)] { break }
            if !d.isEmpty { sends += 1 }
            now += OrbV1.RetransmitQueue.ackTimeout
            XCTAssertLessThan(sends, 10)
        }
        XCTAssertEqual(sends, OrbV1.RetransmitQueue.maxRetries + 1)
        XCTAssertEqual(q.pending, 0)
    }

    func testOrbV1EveryMessageRoundTrips() throws {
        let a = OrbV1.attemptID(UUID())
        let msgs: [OrbV1.Message] = [
            .handshake(kind: .bind, protocolVersion: 1, nonce: [UInt8](repeating: 7, count: 16), proof: [UInt8](repeating: 9, count: 32)),
            .heartbeat(counter: 0xDEADBEEF), .beginPayment(attempt: a, amountCents: 12_999, currency: "USD", timeoutSeconds: 30),
            .beginRead(purpose: .lookup, attempt: a, timeoutSeconds: 0), .cancel(attempt: a), .paymentStatus(attempt: a, outcome: .completed),
            .getStatus, .configure(volume: 70, muted: true), .setLightMode(.emergency, durationSeconds: 600),
            .eventAck(of: 0xBEEF),
            .hello(uid: [1, 2, 3, 4, 5, 6], model: "Orb 1", firmware: "0.1.0", protocolVersion: 1, capabilities: 3, nonce: [UInt8](repeating: 5, count: 16)),
            .handshakeResult(accepted: false, reason: .proximityNotMet, proof: [UInt8](repeating: 0, count: 32)), .commandAck(of: 77, accepted: true, reason: .ok),
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

final class OrbSecureTests: XCTestCase {
    private func h(_ s: String) -> [UInt8] { stride(from: 0, to: s.count, by: 2).map { UInt8(s[s.index(s.startIndex, offsetBy: $0)..<s.index(s.startIndex, offsetBy: $0 + 2)], radix: 16)! } }
    // The same vectors as docs/orb-protocol-vectors.md and apps/orb-firmware/src/secure.rs.
    private let kBind = "a669767ce4577d47d23b35283c54c52c895193c4afdb6715b5ca04f2b2ec90af"
    private let nonceO = "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", bindingId = "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf", nonceT = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf"

    func testProofVectors() {
        XCTAssertEqual(OrbSecure.expectedOrbProofForBind(kBind: h(kBind), nonceO: h(nonceO), bindingId: h(bindingId)), h("cceb9d70218c738390c1a320e367ae8735c649b74bd129f5266e7b26d3444b1a"))
        XCTAssertEqual(OrbSecure.terminalProof(kBind: h(kBind), nonceO: h(nonceO), nonceT: h(nonceT)), h("97c5228ada8f31bcb2512b41ee7bd3350ab1dac5bfd307eea92a78d96cae19d9"))
        XCTAssertEqual(OrbSecure.expectedOrbProofForResume(kBind: h(kBind), nonceO: h(nonceO), nonceT: h(nonceT)), h("308ddb49160b29945bb13fb0b30fd9013be4aa9cacd387e4670ef716b9815bbf"))
        XCTAssertTrue(OrbSecure.constantTimeEqual([1, 2], [1, 2]))
        XCTAssertFalse(OrbSecure.constantTimeEqual([1, 2], [1, 3]))
    }

    func testFrameVectorsAndRefusals() throws {
        var t = OrbSecure.Channel(kBind: h(kBind), nonceO: h(nonceO), bindingId: h(bindingId), generation: 7)
        let plain = h("020001000200000001")
        XCTAssertEqual(try t.seal(plain), h("000000000000000174dc65fda33818d5e7a08bb9904fda8aa048f44efd94e5ac34"))
        // The Orb-to-terminal frame from the vectors opens on the terminal side, once.
        let orbFrame = h("00000000000000029587de8bb36126192f4bc1b03700625752d373a7fccdfeb991")
        XCTAssertEqual(try t.open(orbFrame), plain)
        XCTAssertThrowsError(try t.open(orbFrame)) { XCTAssertEqual($0 as? OrbSecure.ChannelError, .replay) }
        var other = OrbSecure.Channel(kBind: h(kBind), nonceO: h(nonceO), bindingId: h(bindingId), generation: 8)
        XCTAssertThrowsError(try other.open(orbFrame)) { XCTAssertEqual($0 as? OrbSecure.ChannelError, .auth) }
        var bad = orbFrame; bad[10] ^= 1
        var again = OrbSecure.Channel(kBind: h(kBind), nonceO: h(nonceO), bindingId: h(bindingId), generation: 7)
        XCTAssertThrowsError(try again.open(bad)) { XCTAssertEqual($0 as? OrbSecure.ChannelError, .auth) }
        XCTAssertEqual(try again.open(orbFrame), plain)     // a failed frame did not burn the counter
        XCTAssertThrowsError(try again.open([1, 2, 3])) { XCTAssertEqual($0 as? OrbSecure.ChannelError, .length) }
    }
}
