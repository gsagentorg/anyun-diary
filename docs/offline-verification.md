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
