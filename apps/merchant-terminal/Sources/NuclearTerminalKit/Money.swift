import Foundation

/// The API only uses integer minor units (USD cents). These helpers are the only place cents become text and back.
public enum Money {
    /// 12999 -> "$129.99"; negatives show a leading minus: -500 -> "-$5.00".
    public static func format(cents: Int) -> String {
        let sign = cents < 0 ? "-" : ""
        let abs = Swift.abs(cents)
        let dollars = abs / 100
        let digits = String(dollars)
        var grouped = ""
        for (i, ch) in digits.reversed().enumerated() {
            if i > 0 && i % 3 == 0 { grouped.append(",") }
            grouped.append(ch)
        }
        return "\(sign)$\(String(grouped.reversed())).\(String(format: "%02d", abs % 100))"
    }

    /// What a cashier types ("4.50", "4", "0.5") to cents, or nil when it is not a valid non-negative amount with at most two decimals.
    public static func parse(_ text: String) -> Int? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, t.range(of: #"^\d+(\.\d{1,2})?$"#, options: .regularExpression) != nil else { return nil }
        let parts = t.split(separator: ".", omittingEmptySubsequences: false)
        guard let whole = Int(parts[0]) else { return nil }
        var frac = parts.count > 1 ? String(parts[1]) : ""
        while frac.count < 2 { frac.append("0") }
        guard let cents = Int(frac) else { return nil }
        return whole * 100 + cents
    }
}
