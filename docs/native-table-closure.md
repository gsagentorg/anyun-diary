# Native table closure — 2026-11-22

Scope: NativeSleep curve parity, AVPlayer-hit media SWR, and the local media-status bridge. Local source only; no deployment, credentials, real audio, or data publication.

## Implemented

- NativeSleep mirrors the existing Web cliff/hold/stair dB formulas, including stair crossfade slots, clamp/nonfinite handling, hard cut at deadline and no final 2% taper for cut modes. Existing gentle/steady/companion/late/off behavior remains.
- AVPlayer attaches its validated hard-link lease before scheduling refresh. Only age strictly greater than mediaRevalidateSeconds starts a background request. Current item/position/play intent are never mutated by refresh completion.
- Refresh uses the existing streaming file sink with original If-None-Match / If-Modified-Since headers. A bodyless conditional 304 updates only the original entry's createdAt. Full 200 requires the same actual-byte, declared-length, regular-file, Ogg framing/CRC/EOS checks as prefetch; atomic rename preserves old bytes on IO failure. Full replacement drops old validators if the response omits them.
- Refresh and prefetch share one file lane. Same-key refresh is deduplicated; switching waits for canceled worker cleanup. The refresh subscriber propagates cancellation, unlike legacy multi-subscriber scheme data downloads. Media epoch + actor-issued UUID acquired before suspension revoke late 200/304 on clear, replacement (including identical ABA), invalidation, eviction, track switch or cancellation. Failures keep old cache. Attempt cooldown is 60 seconds, at most 128 hashed keys; no raw URL in this state.
- mediaStatus({urls:string[]}) resolves {statuses:[{url:string,cached:boolean}]} in original order (duplicates preserved). Empty batches accepted; over 100 or malformed entries reject the whole batch. Actor and plugin both enforce HTTPS, host present, no user/password/query/fragment, and 8192-byte URL bound. This intentionally accepts stable source URLs only, not transient signed targets. No network, lease creation, LRU touch or index repair. Completeness is checked on the disk actor; raw URLs are not persisted or logged. See the P2 probe closure below for IO/unknown and memo invalidation semantics.

## Tests and entry points

Linux evidence (not Swift execution):

- node scripts/test-native-offline.mjs — 119 source contracts, plus the 12 native sleep source contracts; explicit macOS Swift/WebKit SKIP (rerun after the P2 probe changes).
- node scripts/test-native-offline.mjs --require-swift — exit 1 on this Linux host, with explicit native sleep Swift SKIP and the required gate failure. No Swift behavior pass is claimed.
- node scripts/test-ios-cache.mjs — 142 source contracts.
- npm run test:native-cache — 59 checks.
- npm run test:sleep — 162 checks.
- npm run test:native-audio — serialization/recovery/reconciliation and AVPlayer cache source wiring pass.
- node --check on both new/changed .mjs gates; git diff --check clean.

On macOS, run:

~~~sh
node scripts/test-native-offline.mjs --require-swift
~~~

This now also runs test-native-sleep.mjs --require-swift. The sleep gate compiles the real NativeSleep.swift, executes a 0.001 progress grid plus both sides of all breakpoints for all 8 modes, and compares its stdout with the actual repository TypeScript sleepGain loaded by vite-node. It also executes Swift nonfinite/deadline/revision/finish assertions. No JS implementation stands in for Swift.

The cache gate compiles the actual disk/network/lease/scheme sources with test-native-cache.swift. Added actor tests use synthetic Ogg framing and injected operations (no network): exact age boundary, validators/budget, 304, valid/invalid 200, preserved active inode, failure/cooldown, dedupe and late 200/304 after clear/replacement/cancel/switch/eviction, plus complete/corrupt/missing/empty/invalid mediaStatus batches and no leases/downloads. Probe fixtures additionally cover warm/cold index preservation, cold no-directory/no-sweep/no-eviction, same-inode same-length CRC damage with restored mtime, atomic inode replacement, open/stat permission failure and recovery, a throwing read failure, positive/negative memo reuse, identical store replacement, clear/eviction invalidation and 4097 synthetic entries proving the 4096-memo bound. Permission fixtures require an unprivileged macOS process and fail explicitly if run as root; no real media/network is used.

## P2 probe closure (incremental, 2026-11-22)

- Probe no longer calls validatedEntry or ensureIndexLoaded. Those legacy paths intentionally repair/invalidate/evict and therefore cannot implement a pure read. A warm probe reads the current actor index; a cold probe decodes a throwaway durable snapshot without loading/repairing the actor index, creating directories, sweeping leftovers, changing LRU/leases, or persisting anything. Empty batches return without IO.
- Missing index/entry/file, nonregular file, bad actual length and definite Ogg framing/CRC/EOS failure return false. POSIX ENOENT/ENOTDIR are the only stat errors classified as absent. Index decode/read, other stat errors, open errors and thrown reads propagate. The existing plugin rejects the entire batch with UNAVAILABLE, allowing the existing Web adapter to represent unknown instead of a false uncached answer. No probe error or definite miss removes an index entry or media file.
- Full framing verification now has a throwing FileHandle helper. The original isCompleteOpus Bool API still maps IO failures to false for nonprobe callers; its framing checks were not weakened.
- Both complete and corrupt validation results are memoized in actor-local FIFO memory, capped at 4096 hashed keys. Reuse requires exact entry-snapshot equality plus device, inode, size, nanosecond mtime/ctime, POSIX mode, owner/group and file flags. Cache store/file replacement/invalidate/eviction explicitly forget the key; media/all clear empties the memo. Missing/length failures are cheap fresh checks, not authoritative negative memos.
- Every memo hit still freshly lstats the path, opens the file, fstats the handle and reads one byte; permission/ACL/file-protection errors therefore cannot be hidden by cached validation. Both the open inode and the path fingerprint are checked again after validation/read. A detected concurrent replacement/change throws rather than publishing an answer for old bytes. An unchanged repeated batch does not rescan the complete CRC/EOS contents. No new threads or concurrency model were added; initial changed-file verification still runs on the existing disk actor with the existing 100-URL batch limit.
- Regression counters observe full-verification count and memo cardinality only (no URLs, no maintenance). The Swift fixtures assert repeated positive **and** negative probes do not increase that count, and fingerprint/entry changes do. These are executable macOS tests, not a JavaScript imitation. They have **not run on this host**; the Linux source contracts only check the wiring. There is no measured 512 MB timing claim.
- Incremental local verification: native-offline 119 source contracts + native-sleep 12, ios-cache 142 static contracts, test:native-cache 59 Web adapter checks, node --check and git diff --check pass. Required Swift mode fails as stated above. No TS/application files, deployment or credentials were changed in this increment.

## Remaining native verification boundary

This Linux host has no swiftc/Xcode. Neither Swift compilation nor those behavior tests have run here. CAPPlugin registration/type bridging, AVPlayer/iPhone playback/seek, lock screen, long-background behavior, URLSession redirect/304/timeout delegate behavior and Xcode App target compilation remain UNVERIFIED. The macOS actor gate is not a substitute for App-target build or device acceptance. Required mode fails on a host without Swift; it cannot silently count SKIP as native acceptance.

## Observed test/edit issues (retained evidence)

- The edit tool refused two ambiguous multi-edit requests with: Found 2 occurrences of edits[4]. Inspection showed no disk diff from either refusal; subsequent edits used unique anchors. No blind retry or partial overwrite.
- First ios-cache run rejected the old blanket assertion: 订阅者取消不杀共享 worker（旧缺陷已修）. It matched the new deliberately cancellable, single-owner refresh worker. The assertion is now scoped to the original shared downloadOnce data worker, with a separate positive assertion for native refresh cancellation. Existing shared-subscriber behavior is not weakened.

Concurrent collaborators own lyrics/TS/UI files. Their diff is not part of this native change set. No git add/commit/push or tree-wide git mutation was performed.
