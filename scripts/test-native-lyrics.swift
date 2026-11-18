import Foundation

@main
struct NativeLyricsTests {
    static func main() {
        let lines: [[String: Any]] = [["t": 2.0, "text": "one"], ["t": 5.0, "text": "first"], ["t": 5.0, "text": "second"], ["t": 11.0, "text": "tail first"], ["t": 12.0, "text": "tail second"]]
        assert(NativeLyrics.currentLine(lines, position: 0, duration: 10) == nil)
        assert(NativeLyrics.currentLine(lines, position: 2, duration: 10) == "one")
        assert(NativeLyrics.currentLine(lines, position: 5, duration: 10) == "first")
        assert(NativeLyrics.currentLine(lines, position: 9.9, duration: 10) == "first")
        assert(NativeLyrics.currentLine(lines, position: 10, duration: 10) == "tail first")
        assert(NativeLyrics.currentLine(lines, position: 3, duration: 10) == "one")
        assert(NativeLyrics.currentLine([], position: 3, duration: 10) == nil)
        assert(NativeLyrics.currentLine(lines, position: .nan, duration: 10) == nil)
        let catalog = ["known": lines]
        let queue: [[String: Any]] = [["id": "known", "title": "song"], ["id": "known", "lyrics": []], ["id": "unknown"], ["id": "known", "lyrics": [["t": 0, "text": "remote"]]]]
        let hydrated = NativeLyrics.hydrate(queue, catalog: catalog)
        for index in [0, 1] {
            assert(NativeLyrics.currentLine(hydrated[index]["lyrics"] as! [[String: Any]], position: 5, duration: 10) == "first")
        }
        assert(hydrated[0]["title"] as? String == "song")
        assert(hydrated[2]["lyrics"] == nil)
        assert(NativeLyrics.currentLine(hydrated[3]["lyrics"] as! [[String: Any]], position: 5, duration: 10) == "remote")
        if CommandLine.arguments.count > 2 {
            let catalogData = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
            let realCatalog = try! JSONSerialization.jsonObject(with: catalogData) as! [String: [[String: Any]]]
            let savedData = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
            let preferences = try! PropertyListSerialization.propertyList(from: savedData, format: nil) as! [String: Any]
            let saved = preferences["anyun-native-playback-v1"] as! [String: Any]
            let savedQueue = saved["queue"] as! [[String: Any]]
            let repaired = NativeLyrics.hydrate(savedQueue, catalog: realCatalog)
            assert(repaired.count == savedQueue.count)
            assert(repaired.map { $0["id"] as! String } == savedQueue.map { $0["id"] as! String })
            assert(repaired.allSatisfy { !(($0["lyrics"] as? [[String: Any]]) ?? []).isEmpty })
            print("Device queue: repaired lyrics for all \(repaired.count) entries without changing order or IDs")
        }
        print("NativeLyrics: before-first, exact timestamp, simultaneous lines, tail folding, seek-back and empty input passed")
    }
}
