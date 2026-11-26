# Offline catalog snapshots

The application restores its last validated catalog independently of the current-pointer request. Restoration and online validation race safely: generation, backend base, and existing committed state guard asynchronous state writes. Uncached history is not available offline.

## Persistence

- Web uses CacheStorage; native Capacitor prefers a bounded localStorage fallback independent of the network bridge. Missing/denied/quota-limited storage leaves online behavior intact.
- Backend identity includes origin and base path, without query strings or credentials. Switching backends clears memory but does not cross-hydrate or delete another backend snapshot.
- A refresh saves the validated manifest and up to three complete loaded month documents before switching the pointer. Failure before pointer commit retains the previous complete snapshot. Unreferenced staged documents are cleaned on failure; obsolete revisions are cleaned after success.
- Same-revision checks preserve saved months. Individual loaded months update the pointer only after the full document is stored. At most three month references are retained. Web snapshot budget is 4 MiB; native localStorage fallback is 1 MiB; an individual month is limited to 1.5 MiB and 1500 entries. Insufficient room preserves old snapshots and reports that the offline snapshot was not updated.
- Restore validates schema, revision, counts and audio/lyrics data. Corrupt documents are never treated as fresh. Offline state and last-save time appear above the content; successful online validation clears stale status.
- Catalog snapshots contain stable audio keys, not signed delivery targets. Audio bytes and completeness are managed separately by Web/native audio caches.

## Validation

Run npm run test:catalog-offline for persistence, cold module restart, corruption, backend isolation including base paths, generation ownership, quotas, LRU, full-revision pointer failure, and same-revision preservation.

After a Node build, npm run test:offline-app-browser closes the online tab and opens a fresh offline tab, asserting restored shell, month content, and actual Blob-source playback. The test uses a temporary loopback server and synthetic catalog/audio only. Supply already installed Chromium/playwright-core through CHROMIUM_PATH and PLAYWRIGHT_MODULE; it does not install software or contact production storage.
