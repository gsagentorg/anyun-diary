import Foundation

/// Sample jitter once per retry deadline, never once per watchdog tick.
enum NativeRetry {
    static func delay(attempt: Int, confirmedFailure: Bool, jitter: Double) -> Double {
        let attempt = max(0, attempt)
        // Give a new request time to buffer; a confirmed failure needs no such grace.
        if !confirmedFailure { return 8 }
        let fast = [0.3, 0.5, 1.0, 1.5, 2.0, 2.0, 3.0, 3.0]
        if attempt < fast.count { return fast[attempt] }
        let base = min(10.0, 4.0 * pow(1.5, Double(min(attempt - fast.count, 3))))
        return min(10, base * (0.8 + 0.4 * min(1, max(0, jitter))))
    }
}
