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
        print("NativeLyrics: before-first, exact timestamp, simultaneous lines, tail folding, seek-back and empty input passed")
    }
}
