import Foundation

public struct Orb: Codable, Equatable {
    public let id: String
    public let uid: String
    public let model: String
    public let software: String
}

public struct TerminalInfo: Codable, Equatable {
    public let id: String
    public let name: String
    public let allowRefunds: Bool
    public let orb: Orb?
    enum CodingKeys: String, CodingKey { case id, name, orb; case allowRefunds = "allow_refunds" }
}

public struct Product: Codable, Equatable, Identifiable {
    public let id: String
    public let categoryId: String?
    public let name: String
    public let price: Int
    public let discount: Int
    public let effectivePrice: Int
    public let photo: String?
    public let stock: Int?
    public let active: Bool
    public let status: String
    enum CodingKeys: String, CodingKey {
        case id, name, price, discount, photo, stock, active, status
        case categoryId = "category_id", effectivePrice = "effective_price"
    }
}

public struct CartLine: Codable, Equatable {
    public let productId: String
    public let quantity: Int
    public init(productId: String, quantity: Int) { self.productId = productId; self.quantity = quantity }
    enum CodingKeys: String, CodingKey { case productId = "product_id", quantity }
}

public struct CheckoutItem: Codable, Equatable, Identifiable {
    public let id: String
    public let productId: String?
    public let name: String
    public let unitPrice: Int
    public let netPrice: Int
    public let quantity: Int
    public let refundableQuantity: Int
    enum CodingKeys: String, CodingKey {
        case id, name, quantity
        case productId = "product_id", unitPrice = "unit_price", netPrice = "net_price", refundableQuantity = "refundable_quantity"
    }
}

public struct Checkout: Codable, Equatable, Identifiable {
    public let id: String
    public let status: String          // open | paid | canceled | expired
    public let reference: String?
    public let total: Int
    public let items: [CheckoutItem]
}

/// What happened to a payment attempt. A decline is a recorded outcome (`statusCode` says why), not a transport error.
public struct PaymentResult: Codable, Equatable {
    public let id: String?
    public let status: String          // completed | failed
    public let statusCode: String?     // e.g. insufficient_balance, spend_limit_exceeded
    public let amount: Int?
    enum CodingKeys: String, CodingKey { case id, status, amount; case statusCode = "status_code" }
}

public struct TapAccount: Codable, Equatable {
    public let accountId: String
    public let walletId: String
    public let handle: String?
    public let displayName: String
    public let photo: String?
    public let staff: Bool?
    enum CodingKeys: String, CodingKey {
        case handle, photo, staff
        case accountId = "account_id", walletId = "wallet_id", displayName = "display_name"
    }
}

/// How a refund is requested: the whole payment, an amount, or specific order lines.
public enum RefundMode: Equatable {
    case full
    case partial(amountCents: Int)
    case items([RefundLine], restock: Bool)
}
public struct RefundLine: Codable, Equatable {
    public let checkoutItemId: String
    public let quantity: Int
    public init(checkoutItemId: String, quantity: Int) { self.checkoutItemId = checkoutItemId; self.quantity = quantity }
    enum CodingKeys: String, CodingKey { case checkoutItemId = "checkout_item_id", quantity }
}
