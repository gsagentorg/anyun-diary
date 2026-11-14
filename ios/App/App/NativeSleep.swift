import Foundation

/// Wall-clock sleep state, independent of player callbacks and JavaScript execution.
struct NativeSleep {
    private(set) var revision = ""
    mutating func configure(revision: String, until: Double?, started: Double?, mode: String, afterTrack: Bool) {
        guard revision != self.revision else { return }
        self.revision = revision
        self.until = until; self.started = started; self.mode = mode; self.afterTrack = afterTrack; fired = false
    }
    var until: Double?
    var started: Double?
    var mode = "off"
    var afterTrack = false
    var fired = false

    func decision(at now: Double) -> (stop: Bool, gain: Double) {
        if let until, now >= until { return (true, 0) }
        guard let until, let started, until > started, mode != "off" else { return (false, 1) }
        let t = min(1, max(0, (now - started) / (until - started)))
        func smooth(_ x: Double) -> Double { x * x * (3 - 2 * x) }
        var depth = smooth(t)
        if mode == "steady" { depth = t }
        else if mode == "companion" { depth = t < 0.25 ? 0.3 * smooth(t / 0.25) : 0.3 + 0.7 * smooth((t - 0.25) / 0.75) }
        else if mode == "late" { depth = smooth(max(0, (t - 2.0 / 3.0) * 3)) }
        let gain = pow(10, -3 * depth) * (t > 0.98 ? 1 - smooth((t - 0.98) / 0.02) : 1)
        return (false, gain)
    }
    func stopAtTrackEnd(at now: Double) -> Bool { afterTrack || decision(at: now).stop }
    mutating func finish() {
        until = nil; started = nil; afterTrack = false; fired = true
    }
}
