import Foundation

/// A failed call. `code` is the API's `error` string ("unauthorized", "sold_out", ...); 0 means the network was unreachable.
public struct APIError: Error, Equatable {
    public let status: Int
    public let code: String
    /// True when the terminal's session was revoked or expired: show the sign-in screen.
    public var sessionEnded: Bool { status == 401 }
}

/// The terminal's client for `/v1/terminal/*`. It holds the terminal's own session token (kept in the Keychain by the app).
/// Payments and refunds take an idempotency key (the attempt id): sending the same key again returns the recorded result.
public final class TerminalClient {
    public let baseURL: URL
    private let token: String
    private let session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL; self.token = token; self.session = session
    }

    // MARK: Requests

    func request(_ method: String, _ path: String, query: [String: String] = [:], body: [String: Any]? = nil, idempotencyKey: String? = nil) throws -> URLRequest {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var r = URLRequest(url: comps.url!)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let key = idempotencyKey { r.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        if let body = body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        }
        return r
    }

    func send(_ req: URLRequest) async throws -> (Int, Data) {
        do {
            let (data, resp) = try await session.data(for: req)
            return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
        } catch {
            throw APIError(status: 0, code: "network_error")
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ status: Int, _ data: Data, unwrap key: String? = nil, okStatuses: Set<Int> = [200, 201]) throws -> T {
        guard okStatuses.contains(status) else {
            let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? "http_\(status)"
            throw APIError(status: status, code: code)
        }
        if let key = key {
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], let inner = obj[key] else { throw APIError(status: status, code: "bad_response") }
            return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: inner))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: Terminal and catalog

    public func terminal() async throws -> TerminalInfo {
        let (s, d) = try await send(request("GET", "v1/terminal")); return try decode(TerminalInfo.self, s, d, unwrap: "terminal")
    }
    public func products(categoryId: String? = nil) async throws -> [Product] {
        let (s, d) = try await send(request("GET", "v1/terminal/products", query: categoryId.map { ["category_id": $0] } ?? [:]))
        return try decode([Product].self, s, d, unwrap: "products")
    }
    public func restock(productId: String, quantity: Int) async throws -> Product {
        let (s, d) = try await send(request("POST", "v1/terminal/products/\(productId)/restock", body: ["quantity": quantity]))
        return try decode(Product.self, s, d, unwrap: "product")
    }
    /// Registers the Orb read over Bluetooth (MAC address in any format, model, firmware version).
    public func registerOrb(uid: String, model: String, software: String) async throws -> Orb {
        let (s, d) = try await send(request("PUT", "v1/terminal/orb", body: ["uid": uid, "model": model, "software": software]))
        return try decode(Orb.self, s, d, unwrap: "orb")
    }
    public func signOut() async throws {
        let (s, d) = try await send(request("DELETE", "v1/terminal/session"))
        guard s == 204 || s == 200 else { throw APIError(status: s, code: ((try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["error"] as? String) ?? "http_\(s)") }
    }

    // MARK: Checkouts and payments

    public func createCheckout(lines: [CartLine], reference: String? = nil) async throws -> Checkout {
        var body: [String: Any] = ["items": lines.map { ["product_id": $0.productId, "quantity": $0.quantity] }]
        if let reference = reference { body["reference"] = reference }
        let (s, d) = try await send(request("POST", "v1/terminal/checkouts", body: body))
        return try decode(Checkout.self, s, d, unwrap: "checkout")
    }
    public func createCheckout(amountCents: Int, reference: String? = nil) async throws -> Checkout {
        var body: [String: Any] = ["amount": amountCents]
        if let reference = reference { body["reference"] = reference }
        let (s, d) = try await send(request("POST", "v1/terminal/checkouts", body: body))
        return try decode(Checkout.self, s, d, unwrap: "checkout")
    }
    public func cancelCheckout(id: String) async throws -> Checkout {
        let (s, d) = try await send(request("POST", "v1/terminal/checkouts/\(id)/cancel"))
        return try decode(Checkout.self, s, d, unwrap: "checkout")
    }

    /// Charges a tap. `attemptId` is the idempotency key: reuse it to retry safely. `tapURL` is the payload the Orb read from the tag.
    /// A decline comes back as a result with `status == "failed"` (HTTP 422), not as a thrown error.
    public func pay(checkoutId: String, tapURL: String, attemptId: String) async throws -> PaymentResult {
        let req = try request("POST", "v1/terminal/payments", body: ["checkout_id": checkoutId, "credential": ["type": "tag", "url": tapURL]], idempotencyKey: attemptId)
        let (s, d) = try await send(req)
        if s == 422, let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any], obj["status_code"] != nil || obj["payment"] != nil {
            return try JSONDecoder().decode(PaymentResult.self, from: JSONSerialization.data(withJSONObject: (obj["payment"] as? [String: Any]) ?? obj))
        }
        return try decode(PaymentResult.self, s, d, unwrap: "payment")
    }
    /// Recovers the outcome of an attempt after a dropped connection.
    public func payment(attemptId: String) async throws -> PaymentResult {
        let (s, d) = try await send(request("GET", "v1/terminal/payments/\(attemptId)"))
        return try decode(PaymentResult.self, s, d, unwrap: "payment")
    }
    /// Identifies the customer from a tap (burns the tap: ask for a fresh one before charging).
    public func lookup(tapURL: String) async throws -> TapAccount {
        let (s, d) = try await send(request("POST", "v1/terminal/lookup", body: ["credential": ["type": "tag", "url": tapURL]]))
        return try decode(TapAccount.self, s, d, unwrap: "account")
    }

    // MARK: Refunds

    /// Starts a refund. `tapURL` (a write-staff tap) approves it now; without it the refund may be queued for the owner (HTTP 202).
    public func refund(paymentAttemptId: String, mode: RefundMode, tapURL: String?, attemptId: String) async throws -> (status: Int, body: Data) {
        var body: [String: Any] = ["attempt": paymentAttemptId]
        switch mode {
        case .full: body["mode"] = "full"
        case .partial(let cents): body["mode"] = "partial"; body["amount"] = cents
        case .items(let lines, let restock):
            body["mode"] = "items"; body["restock"] = restock
            body["items"] = lines.map { ["checkout_item_id": $0.checkoutItemId, "quantity": $0.quantity] }
        }
        if let tap = tapURL { body["approval"] = ["credential": ["type": "tag", "url": tap]] }
        let (s, d) = try await send(request("POST", "v1/terminal/refunds", body: body, idempotencyKey: attemptId))
        guard [200, 201, 202].contains(s) else { throw APIError(status: s, code: ((try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["error"] as? String) ?? "http_\(s)") }
        return (s, d)
    }

    // MARK: Close out

    /// Ends the merchant's day: the whole balance is paid to the payout bank now. Needs a tap by staff with the write role (HTTP 403 `approver_not_authorized` otherwise);
    /// a second close-out the same day is 409 `already_closed_out`.
    public func closeOut(tapURL: String) async throws -> CloseOut {
        let (s, d) = try await send(request("POST", "v1/terminal/close-out", body: ["approval": ["credential": ["type": "tag", "url": tapURL]]]))
        return try decode(CloseOut.self, s, d, unwrap: "settlement")
    }
}
