import Foundation
import CoreFoundation

/// Versioned bridge/UserDefaults payload. Reject invalid records atomically, like TS.
struct NativeSleepCustom {
    var holdPercent = 30.0
    var endDb = -24.0
    var exponent = 2.0
    var tailPercent = 10.0
    static func decode(_ value: [String: Any]?, version: Int?) -> NativeSleepCustom {
        guard version == 1, let value else { return NativeSleepCustom() }
        func number(_ key: String, _ low: Double, _ high: Double) -> Double? {
            guard let n = value[key] as? NSNumber,
                  CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
            let d = n.doubleValue
            return d.isFinite && d >= low && d <= high ? d : nil
        }
        guard let hold = number("holdPercent", 0, 90), let db = number("endDb", -60, 0),
              let exponent = number("exponent", 0.25, 4), let tail = number("tailPercent", 0, 30) else { return NativeSleepCustom() }
        return NativeSleepCustom(holdPercent: hold, endDb: db, exponent: exponent, tailPercent: tail)
    }
    var dictionary: [String: Double] { ["holdPercent": holdPercent, "endDb": endDb, "exponent": exponent, "tailPercent": tailPercent] }
}

/// Wall-clock sleep state, independent of player callbacks and JavaScript execution.
struct NativeSleep {
    private(set) var revision = ""
    mutating func configure(revision: String, until: Double?, started: Double?, mode: String, afterTrack: Bool, custom: NativeSleepCustom = NativeSleepCustom()) {
        guard revision != self.revision else { return }
        self.revision = revision
        self.until = until; self.started = started; self.mode = mode; self.afterTrack = afterTrack; self.custom = custom; fired = false
    }
    private(set) var custom = NativeSleepCustom()
    var until: Double?
    var started: Double?
    var mode = "off"
    var afterTrack = false
    var fired = false

    func decision(at now: Double) -> (stop: Bool, gain: Double) {
        if let until, now >= until { return (true, 0) }
        guard let until, let started, until > started, mode != "off" else { return (false, 1) }
        return (false, Self.gain(mode: mode, progress: (now - started) / (until - started), custom: custom))
    }

    /// Formula parity with sleepGain in sleep-curves.ts; executable without AVFoundation.
    static func gain(mode: String, progress: Double, custom: NativeSleepCustom = NativeSleepCustom()) -> Double {
        let t = progress.isFinite ? min(1, max(0, progress)) : 0
        if mode == "off" { return 1 }
        if t >= 1 { return 0 }
        func smooth(_ x: Double) -> Double { x * x * (3 - 2 * x) }
        if mode == "custom" {
            let hold = custom.holdPercent / 100
            let tail = min(custom.tailPercent / 100, (1 - hold) / 2)
            let fade = 1 - hold - tail
            let u = max(0, min(1, (t - hold) / fade))
            let gain = pow(10, custom.endDb * pow(u, custom.exponent) / 20)
            return gain * (tail > 0 && t > 1 - tail ? 1 - smooth((t - (1 - tail)) / tail) : 1)
        }
        var depth = smooth(t)
        if mode == "steady" { depth = t }
        else if mode == "companion" { depth = t < 0.25 ? 0.3 * smooth(t / 0.25) : 0.3 + 0.7 * smooth((t - 0.25) / 0.75) }
        else if mode == "late" { depth = smooth(max(0, (t - 2.0 / 3.0) * 3)) }
        else if mode == "cliff" { depth = 0.24 * t * t * t }
        else if mode == "hold" { depth = t < 0.82 ? 0 : 0.2 * smooth(min(1, (t - 0.82) / 0.15)) }
        else if mode == "stair" {
            let levels: [Double] = [0, 0.1, 0.2, 0.3]
            let index = min(3, Int(floor(t / 0.25)))
            let local = (t - Double(index) * 0.25) / 0.25
            let from = levels[index]
            let to = levels[min(3, index + 1)]
            depth = from + (to - from) * smooth(max(0, min(1, (local - 0.9) / 0.1)))
        }
        let gain = pow(10, (-60 * depth) / 20)
        if ["cliff", "hold", "stair"].contains(mode) { return gain }
        return gain * (t > 0.98 ? 1 - smooth((t - 0.98) / 0.02) : 1)
    }
    func stopAtTrackEnd(at now: Double) -> Bool { afterTrack || decision(at: now).stop }
    mutating func finish() {
        until = nil; started = nil; afterTrack = false; fired = true
    }
}
