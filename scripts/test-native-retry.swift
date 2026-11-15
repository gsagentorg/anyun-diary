import Foundation
@main struct NativeRetryTests {
    static func main() {
        for jitter in [0.0, 0.5, 1.0] {
            assert(NativeRetry.delay(attempt: 0, confirmedFailure: true, jitter: jitter) == 0.5)
            assert(NativeRetry.delay(attempt: 1, confirmedFailure: true, jitter: jitter) == 1)
            assert(NativeRetry.delay(attempt: 2, confirmedFailure: true, jitter: jitter) == 2)
            assert(NativeRetry.delay(attempt: 0, confirmedFailure: false, jitter: jitter) == 15)
            for attempt in 3...100 {
                let delay = NativeRetry.delay(attempt: attempt, confirmedFailure: true, jitter: jitter)
                assert(delay > 0 && delay <= 60)
            }
        }
        assert(NativeRetry.delay(attempt: 3, confirmedFailure: true, jitter: 0) == 3)
        assert(NativeRetry.delay(attempt: 3, confirmedFailure: true, jitter: 1) == 5)
        assert(NativeRetry.delay(attempt: 4, confirmedFailure: true, jitter: 0.5) == 8)
        print("NativeRetry: fast retries, exponential delay, jitter and cap passed")
    }
}
