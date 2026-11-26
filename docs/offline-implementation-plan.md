# Complete offline playback implementation

## Scope

Continue from the existing background-recovery commit. Implement missing cache behavior rather than re-reporting prior completion. Work only on the feature line; no deployment branch updates, remote pushes, data publication, credential changes, or source-audio changes.

## Acceptance criteria

1. Web: persist complete audio files under stable source keys, distinguish complete files from playback buffers, enforce byte/entry bounds and eviction, support offline replay and seeking, expose storage statistics and clearing. Partial/opaque/failed downloads must never count as cached. Cache errors must not break online playback.
2. Web shell: install a versioned service worker on supported secure web origins, retain required scripts/styles for offline reopening, and avoid forcing reloads or caching runtime audio into build outputs. Native Capacitor does not depend on a service worker.
3. Native iOS: queue carries stable HTTPS routes; AVPlayer consumes valid cached local files, otherwise streams online while cache fills. Signed delivery targets remain ephemeral. Cancelled/late tasks cannot replace a newer track or resume user-paused audio. Playing files remain usable during eviction/clear.
4. Catalog: restore validated, bounded snapshots before requiring a successful current-pointer request, isolate snapshots by backend, preserve last-good data on failures, and reject stale/corrupt results. Show offline/stale state honestly.
5. Regression: preserve existing playback modes, queue identity, lyrics, sleep behavior and background recovery. Run behavioral persistence/failure/cancellation tests, existing regressions, and Node/Capacitor builds. Exercise web offline behavior in installed headless Chromium using synthetic fixtures only.

## Verification boundaries

Browser storage remains subject to user/browser eviction and quota. Audio never cached completely cannot be played offline. Cross-origin media must permit browser reads; do not add an unauthorized server audio proxy to bypass CORS. No installed-package or Swift static assertion is a substitute for an Xcode build or an iPhone test.
