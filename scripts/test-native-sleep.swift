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
            var sleep = NativeSleep()
            sleep.configure(revision: "start", until: 61000, started: 1000, mode: mode, afterTrack: false)
            let decision = sleep.decision(at: 1000 + 60000 * progress)
            assert(!decision.stop)
            assert(abs(decision.gain - expected) < 1e-12, "web/native curve mismatch: \(mode), \(progress)")
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
        print("NativeSleep: \(fixtures.count) web/native curve comparisons and deadline, resume, track-end, cancellation, stale-sync and rearm checks passed")
    }
}
