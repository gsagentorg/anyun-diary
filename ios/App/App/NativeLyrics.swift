import Foundation

/// Matches the web metadata rule: latest timestamp, first line of a simultaneous group.
enum NativeLyrics {
    static let bundled: [String: [[String: Any]]] = {
        guard let url = Bundle.main.url(forResource: "native-lyrics", withExtension: "json", subdirectory: "public"),
              let data = try? Data(contentsOf: url),
              let catalog = try? JSONSerialization.jsonObject(with: data) as? [String: [[String: Any]]] else { return [:] }
        return catalog
    }()

    /// Repair older persisted queues and incomplete JS metadata without changing playback.
    static func hydrate(_ items: [[String: Any]], catalog: [String: [[String: Any]]] = bundled) -> [[String: Any]] {
        items.map { item in
            guard (item["lyrics"] as? [[String: Any]])?.isEmpty != false,
                  let id = item["id"] as? String, let lines = catalog[id], !lines.isEmpty else { return item }
            var hydrated = item
            hydrated["lyrics"] = lines
            return hydrated
        }
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
