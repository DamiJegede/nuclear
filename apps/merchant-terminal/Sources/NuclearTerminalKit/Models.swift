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
    public let total: Int              // the items; a tip is added when it is paid
    public let items: [CheckoutItem]
    public let tipAmount: Int?         // written once, when the order is paid
    public let servedBy: String?       // the staff member's account that serves the order
    enum CodingKeys: String, CodingKey { case id, status, reference, total, items; case tipAmount = "tip_amount", servedBy = "served_by" }
}

/// What happened to a payment attempt. A decline is a recorded outcome (`statusCode` says why), not a transport error.
public struct PaymentResult: Codable, Equatable {
    public let id: String?
    public let status: String          // completed | failed
    public let statusCode: String?     // e.g. insufficient_balance, spend_limit_exceeded
    public let amount: Int?            // everything the payer paid, the tip included
    public let tipAmount: Int?         // the part of `amount` that is tip
    public let servedBy: String?       // the staff member's account that served the payment
    enum CodingKeys: String, CodingKey { case id, status, amount; case statusCode = "status_code", tipAmount = "tip_amount", servedBy = "served_by" }
}

/// A staff member of the merchant, as the terminal lists them. `id` is what a payment's `servedBy` and a tip split name.
public struct StaffMember: Codable, Equatable, Identifiable {
    public let id: String
    public let staffAccountId: String
    public let name: String
    public let handle: String?
    public let role: String            // read | write
    enum CodingKeys: String, CodingKey { case id, name, handle, role; case staffAccountId = "staff_account_id" }
}
public struct StaffList: Codable, Equatable {
    public let staff: [StaffMember]
    public let activeStaffId: String?
    enum CodingKeys: String, CodingKey { case staff; case activeStaffId = "active_staff_id" }
}
/// One person's share of a tip, in cents. A tip splits by amounts that add up to the whole tip.
public struct TipShare: Equatable {
    public let staffId: String
    public let amountCents: Int
    public init(staffId: String, amountCents: Int) { self.staffId = staffId; self.amountCents = amountCents }
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

/// The result of ending the day (`POST /v1/terminal/close-out`): the whole balance paid to the payout bank.
public struct CloseOut: Codable, Equatable {
    public let id: String
    public let date: String
    public let amount: Int
    /// `instant` or `ach`.
    public let rail: String
    /// `completed` once the bank has settled it, `pending` while it is on its way.
    public let status: String
    /// `instant`, `today` or `next_business_day`.
    public let arrival: String
}
