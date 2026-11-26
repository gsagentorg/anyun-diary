import Foundation

@main
struct NativeSleepTests {
    static func main() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let fixtures = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        for fixture in fixtures {
            let mode = fixture["mode"] as! String
            let progress = (fixture["progress"] as! NSNumber).doubleValue
            let expected = (fixture["gain"] as! NSNumber).doubleValue
            let custom = NativeSleepCustom.decode(fixture["custom"] as? [String: Any], version: 1)
            let direct = NativeSleep.gain(mode: mode, progress: progress, custom: custom)
            precondition(abs(direct - expected) < 1e-12, "direct TS/Swift parity")
            for invalid in [Double.nan, Double.infinity, -Double.infinity] {
                precondition(NativeSleep.gain(mode: mode, progress: invalid, custom: custom) == 1)
            }
            var sleep = NativeSleep()
            sleep.configure(revision: "start", until: 61000, started: 1000, mode: mode, afterTrack: false, custom: custom)
            let decision = sleep.decision(at: 1000 + 60000 * progress)
            if progress >= 1 { precondition(decision.stop); continue }
            assert(!decision.stop)
            // Compare wall-clock decision at its reconstructed phase. The direct
            // exact fixture-phase Swift/TS comparison above stays strict (1e-12).
            let reconstructed = ((1000 + 60000 * progress) - 1000) / 60000
            let expectedDecision = NativeSleep.gain(mode: mode, progress: reconstructed, custom: custom)
            precondition(abs(decision.gain - expectedDecision) < 1e-12, "wall-clock phase formula mismatch")
            assert(sleep.decision(at: 61000).stop, "all modes stop at the deadline")
        }
        var sleep = NativeSleep()
        sleep.configure(revision: "one", until: 61000, started: 1000, mode: "steady", afterTrack: false)
        let resumed = sleep.decision(at: 31000)
        assert(!resumed.stop && abs(resumed.gain - pow(10, -1.5)) < 1e-12, "paused time counts; resume uses current gain")
        assert(sleep.decision(at: 100000).stop, "late resume must stop before emitting audio")
        assert(!sleep.stopAtTrackEnd(at: 30000), "ordinary track end advances before deadline")
        assert(sleep.stopAtTrackEnd(at: 61000), "deadline takes priority over advancing")
        sleep.finish()
        assert(sleep.fired && sleep.until == nil && !sleep.afterTrack)
        assert(sleep.decision(at: 100000).gain == 1, "after stopping, future playback uses normal volume")
        sleep.configure(revision: "one", until: 61000, started: 1000, mode: "steady", afterTrack: false)
        assert(sleep.fired && sleep.until == nil, "stale queue/settings sync cannot rearm a finished timer")
        sleep.configure(revision: "two", until: 120000, started: 60000, mode: "late", afterTrack: false)
        assert(!sleep.fired && sleep.until == 120000, "explicit new sleep intent rearms timer")
        sleep.configure(revision: "cancel", until: nil, started: nil, mode: "late", afterTrack: false)
        assert(!sleep.decision(at: 200000).stop && sleep.decision(at: 200000).gain == 1, "cancel restores volume and clears deadline")
        sleep.configure(revision: "after", until: nil, started: nil, mode: "off", afterTrack: true)
        assert(sleep.stopAtTrackEnd(at: 1000) && !sleep.decision(at: 1000).stop, "after-track stops only on natural completion")
        sleep.finish()
        assert(!sleep.afterTrack && sleep.fired)
        let first = NativeSleepCustom(holdPercent: 90, endDb: -12, exponent: 0.25, tailPercent: 30)
        sleep.configure(revision: "custom-start", until: 61000, started: 1000, mode: "custom", afterTrack: false, custom: first)
        sleep.configure(revision: "custom-start", until: 120000, started: 0, mode: "custom", afterTrack: false, custom: NativeSleepCustom())
        precondition(sleep.custom.endDb == -12 && sleep.until == 61000, "same revision cannot mutate running snapshot")
        let stored = sleep.custom.dictionary
        let restoredCustom = NativeSleepCustom.decode(stored, version: 1)
        var restored = NativeSleep()
        restored.configure(revision: sleep.revision, until: sleep.until, started: sleep.started, mode: sleep.mode, afterTrack: sleep.afterTrack, custom: restoredCustom)
        for time in [1000.0, 31000, 57000, 58000, 60999, 61000, 90000] {
            precondition(restored.decision(at: time).gain == sleep.decision(at: time).gain, "persisted snapshot/revision restores exactly")
        }
        for bad in [[:], ["holdPercent": true], ["holdPercent": "30"], ["holdPercent": 30, "endDb": -12, "exponent": Double.nan, "tailPercent": 10], ["holdPercent": 91, "endDb": -12, "exponent": 2, "tailPercent": 10]] as [[String: Any]] {
            precondition(NativeSleepCustom.decode(bad, version: 1).endDb == -24, "bad native payload defaults atomically")
        }
        precondition(NativeSleepCustom.decode(stored, version: 2).endDb == -24, "unknown version safe defaults")
        sleep.finish()
        sleep.configure(revision: "custom-start", until: 120000, started: 0, mode: "custom", afterTrack: false, custom: first)
        precondition(sleep.fired && sleep.until == nil, "stale custom does not rearm")
        sleep.configure(revision: "custom-new", until: 120000, started: 0, mode: "custom", afterTrack: false)
        precondition(!sleep.fired && sleep.custom.endDb == -24, "new revision rearms new snapshot")
        print("NativeSleep: \(fixtures.count) web/native curve comparisons and deadline, resume, track-end, cancellation, stale-sync and rearm checks passed")
    }
}
