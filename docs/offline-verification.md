# Offline implementation verification

Status: feature-line work; not deployed and no data publication. Background-recovery baseline 84491e1 remains intact.

## Independently verified

- Web cache behavior: 124 checks, including full-200-only admission, cold persistence, LRU byte bounds, multiple evictions, concurrent downloads, clear during an active write, quota failure, cancellation, Blob lifetime and playback renewal.
- Catalog persistence: 112 checks, including restart hydration, validation, backend/base-path isolation, late-result ownership, three-month retention, same-revision preservation, pointer-failure rollback, initial-save/month-save queue ordering and pre-clear fetch ownership.
- Existing background recovery: 94 checks. Existing catalog/storage/delivery/renewal, month supply, lyrics, playlist/shuffle, timeline, session, sleep, player operations, native bridge, brand and heatmap tests passed in the full test run.
- Type checking: zero errors and zero warnings.
- Real Chromium media test: complete cache admission, offline playback and seek after memory reload, invalid partial rejection, byte limits and clearing passed using synthetic WAV only.
- Real production Node application test: opened online, cached shell/catalog/audio, paused, closed the tab, disabled networking, then opened a new tab. Service-worker shell restored, offline catalog restored, saved queue played from Blob; no application page errors. This is not merely a module mock.
- Node and Capacitor Web builds passed. The existing optional PUBLIC_LIVE_ROOM_ID export warning remains; it did not fail either build.
- Tests after the full-suite stop were run separately: interactions passed, migration 44 tests passed, queue byte-budget tests passed. No real storage publication occurred.

## Explicit gates

- npm test still stops at the pre-existing architecture assertion that forbids upload-blob references in package scripts. The same audio:upload/audio:migrate/test:blob script names are present at baseline 84491e1. This unrelated compatibility-tool policy was not removed or weakened to manufacture a green suite.
- Native implementation/source review is complete, including scoped JSON clear and latest-started-request ownership for 200/304 (no stale resurrection or ABA age reset). Parent reran native bridge/cache tests (59), iOS source assertions (138) and native-offline source contracts (56). Swift execution was explicitly SKIPPED; --require-swift fails on this host rather than claiming success. Static contracts do not prove an Xcode build or iPhone playback. No macOS/Xcode toolchain is available on this host. iPhone codec/local-file playback, seek, lock-screen and long-background acceptance remain device gates.
- Chromium testing does not establish Safari/iPhone browser behavior. Browser/OS storage may be evicted; audio not completely saved cannot play offline.

## Reproduce

Use npm run test:web-offline, npm run test:catalog-offline, npm run check and npm run build. For installed-browser tests set PLAYWRIGHT_MODULE and CHROMIUM_PATH, then run npm run test:web-offline-browser or npm run test:offline-app-browser. The production application test requires the Node build directory; the Capacitor Web build is not a Swift/iOS build.

## Full feature-table closure integration (local, not published)

- NativeSleep now implements the three hard-cut modes with the same TS formulas; the required macOS entry compiles the actual Swift and compares a dense grid/boundaries against the actual TypeScript implementation. Linux source checks passed; actual Swift remains unverified.
- Current AVPlayer local-hit path now schedules conditional file-based SWR only after attaching the local lease. A refresh cannot reinstall or resume the current player. Single-lane cancellation, UUID/epoch ownership, 304-only age update, atomic full-200 replacement and bounded failure cooldown have source/fixture coverage; real URLSession/AVPlayer execution still requires macOS/iPhone.
- NativeLyrics restores from the same persisted queue entry or its audio snapshot, not a bundled site-wide lyric table. The old build hook only removes its exact obsolete generated file. Historical data.json is kept locally but no longer tracked; new builds need no catalog/lyrics data in source. No history rewrite or source-audio changes occurred.
- Native mode reconciliation now honors the persisted repeatOne flag; a regression covers repeat-one, sequential and random snapshots.
- Parent reruns: availability 59, runtime-lyrics cleanup/source 13, native-offline source 79, native-sleep source 12, iOS source 142; session/native bridge passed; check 0 errors/0 warnings. Source checks explicitly do not execute Swift. Required-Swift mode was observed to fail without the toolchain.
- Fresh Node build plus the real production UI harness passed **8/8**: mode order, secondary clear including current playback, non-dot sleep-line drag and cancellation/minimum time, refresh without restarting playback, confirmed-only reload, cached-vs-uncached offline playback, cross-origin images without ACAO/crossorigin and heatmap through today. See feature-table-browser.md. Separate offline cold-reopen playback also passed.
- Full npm test still stops at the unchanged pre-existing architecture/upload-blob policy assertion; interactions, migration 44 and queue-budget were run separately and passed. This is not a green-full-suite claim.
- Custom curve editor remains an unresolved product choice, not silently abandoned. Swift/Xcode/App-target/iPhone and publication remain separate acceptance/authorization gates.

### Stable frontend re-verification after interrupted integration

The final five-component offline marking snapshot was independently checked again: check 0 errors/0 warnings; offline-availability 131 behavior/real-template assertions; runtime-lyrics 13 cleanup/source checks. A fresh Node build, all eight production Chromium feature scenarios and the cold shell/catalog/Blob playback test passed. A subsequent Capacitor web build also passed. The exact obsolete native-lyrics.json is absent from static/, build/client/ and cap/; the local historical data file remains unchanged and untracked. The earlier failed Capacitor build was captured during a concurrent intermediate edit, inspected before retry, and superseded only after the corrected stable-source build succeeded. Capacitor web success is not an App-target/Swift build claim.

### Native probe review follow-up

Parent reviewed the final probe increment and reran native-offline 119 source contracts, native-sleep 12 source contracts, ios-cache 142 source assertions, native-cache 59 checks and native-audio bridge tests. Transient probe IO now propagates to unknown without index invalidation; repeated integrity results use bounded, fingerprint-guarded memoization with fresh open/read checks. See native-table-closure.md for unexecuted macOS fixtures and performance boundaries. Both native-offline and runtime-lyrics required-Swift commands were observed to fail on this Linux host; there is still no native compilation/device acceptance claim.
