import Foundation

/// Sample jitter once per retry deadline, never once per watchdog tick.
enum NativeRetry {
    static func delay(attempt: Int, confirmedFailure: Bool, jitter: Double) -> Double {
        let attempt = max(0, attempt)
        if !confirmedFailure && attempt == 0 { return 15 }
        let fast = [0.5, 1.0, 2.0]
        if attempt < fast.count { return fast[attempt] }
        let base = min(60.0, 4.0 * pow(2.0, Double(min(attempt - 3, 4))))
        return min(60, base * (0.75 + 0.5 * min(1, max(0, jitter))))
    }
}
