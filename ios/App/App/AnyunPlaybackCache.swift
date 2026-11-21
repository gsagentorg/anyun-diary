// UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
// Playback leases share the disk actor with index/clear/eviction. No main-thread filesystem IO.
import Foundation
import Darwin

struct AnyunPlaybackLookup: Sendable {
    let url: URL?
    let mediaEpoch: Int
}

@MainActor
final class AnyunPlaybackCache {
    static let shared = AnyunPlaybackCache()
    private let disk: AnyunDiskCache

    init(disk: AnyunDiskCache = .shared) { self.disk = disk }

    func localPlaybackURL(forKey key: String) async -> AnyunPlaybackLookup {
        return await disk.acquirePlaybackLease(key: key)
    }

    func releaseAllLeases() async { await disk.releasePlaybackLeases() }
    func purgeStaleLeases() async { await disk.releasePlaybackLeases() }

    /// Called ONLY by the disk actor (or isolated temporary-directory tests).
    /// Hard links are mandatory: symlink/direct-bin fallback cannot survive clear/eviction.
    nonisolated static func refreshLease(forKey key: String, layout: AnyunCacheLayout) -> URL? {
        let manager = FileManager.default
        guard let link = layout.playbackLink(forKey: key) else { return nil }
        let media = layout.mediaFile(forKey: key)
        guard manager.fileExists(atPath: media.path) else { return nil }
        let staged = layout.playbackDirectory.appendingPathComponent(".lease-\(UUID().uuidString)")
        defer { try? manager.removeItem(at: staged) }
        do {
            try manager.createDirectory(at: layout.playbackDirectory, withIntermediateDirectories: true)
            // Make a new hard link first, then POSIX atomic rename over the old lease.
            // Failure at either step leaves the existing playback path untouched.
            try manager.linkItem(at: media, to: staged)
            guard Darwin.rename(staged.path, link.path) == 0 else { return nil }
            return link
        } catch { return nil }
    }

    nonisolated static func isDeletable(linkName: String, recent: [String]) -> Bool {
        guard linkName.hasSuffix(".\(AnyunCacheLayout.playbackExtension)") else { return false }
        let stem = String(linkName.dropLast(AnyunCacheLayout.playbackExtension.count + 1))
        guard AnyunCacheLayout.isValidKey(stem) else { return false }
        return !recent.contains(stem)
    }

    nonisolated static func trimmedRecent(_ key: String, previous: [String]) -> [String] {
        return Array(([key] + previous.filter { $0 != key }).prefix(2))
    }
}
