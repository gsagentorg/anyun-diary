import Foundation
@main struct NativeRetryTests {
    static func main() {
        let fast = [0.3, 0.5, 1.0, 1.5, 2.0, 2.0, 3.0, 3.0]
        for jitter in [0.0, 0.5, 1.0] {
            for (attempt, expected) in fast.enumerated() {
                assert(NativeRetry.delay(attempt: attempt, confirmedFailure: true, jitter: jitter) == expected)
            }
            for attempt in 0...100 {
                assert(NativeRetry.delay(attempt: attempt, confirmedFailure: false, jitter: jitter) == 8,
                    "unconfirmed buffering must not be interrupted by aggressive failed-request retries")
                let delay = NativeRetry.delay(attempt: attempt, confirmedFailure: true, jitter: jitter)
                assert(delay > 0 && delay <= 10, "continued failures never require a minute-long wait")
            }
        }
        assert(abs(NativeRetry.delay(attempt: 8, confirmedFailure: true, jitter: 0) - 3.2) < 1e-9)
        assert(abs(NativeRetry.delay(attempt: 8, confirmedFailure: true, jitter: 1) - 4.8) < 1e-9)
        assert(NativeRetry.delay(attempt: 9, confirmedFailure: true, jitter: 0.5) == 6)
        assert(NativeRetry.delay(attempt: 30, confirmedFailure: true, jitter: 1) == 10)
        print("NativeRetry: eight fast attempts, continued retry cap, jitter and buffering grace passed")
    }
}
