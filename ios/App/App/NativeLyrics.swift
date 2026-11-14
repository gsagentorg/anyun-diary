import Foundation

/// Matches the web metadata rule: latest timestamp, first line of a simultaneous group.
enum NativeLyrics {
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
