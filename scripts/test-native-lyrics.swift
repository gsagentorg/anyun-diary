import Foundation

@main
struct RuntimeLyricsTests {
    static var checks = 0
    static func expect(_ value: @autoclosure () -> Bool, _ message: String) {
        guard value() else { fatalError(message) }
        checks += 1
    }
    static func lyrics(_ item: [String: Any]) -> [[String: Any]] { item["lyrics"] as? [[String: Any]] ?? [] }
    static func same(_ a: Any, _ b: Any) -> Bool {
        NSDictionary(dictionary: ["value": a]).isEqual(to: ["value": b])
    }
    static func main() throws {
        let lines: [[String: Any]] = [
            ["t": 2.0, "text": "one"], ["t": 5.0, "text": "first"],
            ["t": 5.0, "text": "second"], ["t": 11.0, "text": "tail first"],
            ["t": 12.0, "text": "tail second"]]
        expect(NativeLyrics.currentLine(lines, position: 0, duration: 10) == nil, "before first")
        expect(NativeLyrics.currentLine(lines, position: 2, duration: 10) == "one", "exact timestamp")
        expect(NativeLyrics.currentLine(lines, position: 5, duration: 10) == "first", "first simultaneous line")
        expect(NativeLyrics.currentLine(lines, position: 9.999, duration: 10) == "first", "before duration")
        expect(NativeLyrics.currentLine(lines, position: 10, duration: 10) == "tail first", "tail folded to duration")
        expect(NativeLyrics.currentLine(lines, position: 20, duration: 10) == "tail first", "past duration group")
        expect(NativeLyrics.currentLine(lines, position: 3, duration: 10) == "one", "seek backwards")
        expect(NativeLyrics.currentLine([], position: 3, duration: 10) == nil, "empty lines")
        for position in [Double.nan, Double.infinity, -Double.infinity] {
            expect(NativeLyrics.currentLine(lines, position: position, duration: 10) == nil, "nonfinite position")
        }
        for duration in [0.0, -1.0, Double.nan, Double.infinity, -Double.infinity] {
            expect(NativeLyrics.currentLine(lines, position: 11, duration: duration) == "tail first", "invalid duration uses source time")
            expect(NativeLyrics.currentLine(lines, position: 12, duration: duration) == "tail second", "unfolded tail")
        }
        let boundary: [[String: Any]] = [["t": 10.0, "text": "at end"], ["t": 11.0, "text": "beyond end"]]
        expect(NativeLyrics.currentLine(boundary, position: 9.999, duration: 10) == nil, "end group not early")
        expect(NativeLyrics.currentLine(boundary, position: 10, duration: 10) == "at end", "exact end precedes folded tail")
        let nested: [[String: Any]] = [["t": 0.0, "text": "nested runtime"]]
        let other: [[String: Any]] = [["t": 0.0, "text": "other entry runtime"]]
        let queue: [[String: Any]] = [
            ["id": "duplicate", "lyrics": lines, "audio": ["lyrics": nested]],
            ["id": "duplicate", "lyrics": [], "audio": ["id": "same-audio", "lyrics": nested]],
            ["id": "duplicate", "audio": ["id": "same-audio", "lyrics": other]],
            ["id": "duplicate", "title": "same title", "startAt": 1],
            ["id": "duplicate", "lyrics": [], "audio": ["lyrics": []]],
            ["audio": ["lyrics": nested], "custom": ["preserve": true]],
            ["lyrics": NSNull(), "audio": ["lyrics": nested]],
            ["lyrics": [], "audio": ["lyrics": [["t": "not numeric", "text": "invalid"]]]],
            ["lyrics": [], "audio": ["lyrics": [["t": 0, "text": 123]]]],
            ["lyrics": [], "audio": ["lyrics": [["t": 2, "text": "late"], ["t": 1, "text": "early"]]]],
            ["lyrics": [], "audio": ["lyrics": [["t": true, "text": "boolean timestamp"]]]],
            ["audio": ["lyrics": []]],
            ["title": "same title", "startAt": 1]
        ]
        // Real queueJSON round trip; no site data, bundle or disk catalog supplied.
        let encoded = try JSONSerialization.data(withJSONObject: queue, options: [.sortedKeys])
        let saved = try JSONSerialization.jsonObject(with: encoded) as! [[String: Any]]
        let hydrated = NativeLyrics.hydrate(saved)
        expect(hydrated.count == saved.count, "count unchanged")
        expect(same(lyrics(hydrated[0]), lines), "top-level snapshot wins over different audio snapshot")
        expect(same(lyrics(hydrated[1]), nested), "empty top repaired from its own audio")
        expect(same(lyrics(hydrated[2]), other), "duplicate entry/audio IDs cannot cross-contaminate")
        expect(hydrated[3]["lyrics"] == nil, "legacy missing lyrics stays missing despite duplicate ID/title/date")
        expect(same(hydrated[4], saved[4]), "explicit empty top and audio remain unchanged")
        expect(same(lyrics(hydrated[5]), nested), "no ID required for item-local repair")
        expect(same(lyrics(hydrated[6]), nested), "JSON null top repaired from own audio")
        for index in [7, 8, 9, 10, 11, 12] {
            expect(same(hydrated[index], saved[index]), "invalid or missing snapshot remains unchanged")
        }
        for (before, after) in zip(saved, hydrated) {
            expect(same(before.filter { $0.key != "lyrics" }, after.filter { $0.key != "lyrics" }), "identity/order/metadata and nested audio unchanged")
        }
        expect(same(saved, queue), "input queue not mutated")
        expect(same(NativeLyrics.hydrate(hydrated), hydrated), "hydration idempotent")
        expect(NativeLyrics.hydrate([]).isEmpty, "empty queue")
        let simultaneous: [[String: Any]] = [["audio": ["lyrics": lines]]]
        expect(same(lyrics(NativeLyrics.hydrate(simultaneous)[0]), lines), "duplicate timestamps are a valid nested snapshot")
        for timestamp in [Double.nan, Double.infinity, -Double.infinity] {
            let invalid: [[String: Any]] = [["audio": ["lyrics": [["t": timestamp, "text": "invalid"]]]]]
            expect(NativeLyrics.hydrate(invalid)[0]["lyrics"] == nil, "nonfinite nested timestamp rejected")
        }
        print("runtime-lyrics: \(checks) Swift behavior assertions passed")
    }
}
