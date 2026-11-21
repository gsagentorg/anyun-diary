import Foundation
import CoreFoundation

/// Matches the web metadata rule: latest timestamp, first line of a simultaneous group.
enum NativeLyrics {
    /// Restore only from the same queue entry's persisted runtime snapshot.
    /// A nonempty top-level snapshot wins; absent/empty lyrics may be repaired
    /// from audio.lyrics, never from another entry or a newer catalog release.
    static func hydrate(_ items: [[String: Any]]) -> [[String: Any]] {
        items.map { item in
            guard (item["lyrics"] as? [[String: Any]])?.isEmpty != false,
                  let audio = item["audio"] as? [String: Any],
                  let lines = audio["lyrics"] as? [[String: Any]],
                  !lines.isEmpty, validSnapshot(lines) else { return item }
            var hydrated = item
            hydrated["lyrics"] = lines
            return hydrated
        }
    }

    private static func validSnapshot(_ lines: [[String: Any]]) -> Bool {
        var previous = -Double.infinity
        for line in lines {
            guard let timestamp = line["t"] as? NSNumber,
                  CFGetTypeID(timestamp) != CFBooleanGetTypeID(),
                  timestamp.doubleValue.isFinite, timestamp.doubleValue >= previous,
                  line["text"] is String else { return false }
            previous = timestamp.doubleValue
        }
        return true
    }

    static func currentLine(_ lyrics: [[String: Any]], position: Double, duration: Double) -> String? {
        guard position.isFinite, !lyrics.isEmpty else { return nil }
        let limit = duration.isFinite && duration > 0 ? duration : Double.infinity
        func time(_ index: Int) -> Double {
            min((lyrics[index]["t"] as? NSNumber)?.doubleValue ?? Double.infinity, limit)
        }
        var lo = 0, hi = lyrics.count - 1, found = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if time(mid) <= position { found = mid; lo = mid + 1 }
            else { hi = mid - 1 }
        }
        guard found >= 0 else { return nil }
        let timestamp = time(found)
        while found > 0 && time(found - 1) == timestamp { found -= 1 }
        return lyrics[found]["text"] as? String
    }
}
