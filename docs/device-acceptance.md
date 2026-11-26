# iPhone / Mac device acceptance checklist

The Linux build host has no Swift toolchain and no iPhone, so every native change lands
**source-verified only** (source contracts + Linux/Chromium suites). This list consolidates the
open device gates from the issue-loop PRs (#44–#51) and the released baseline (#52). Owner runs
on real hardware; items already accepted earlier (compile/install, system controls, lock-screen
lyrics, headphone interruption, native offline playback, sleep cancel/expiry, full-line drag hit)
are NOT repeated here.

Legend: `[ ]` open gate · PR link = where the change lives · "Mac gate" = compilation/execution of
Swift unit-style regressions (`--require-swift` or the macOS CI job once PR #48 lands).

## 0. Mac compile gate (blocks all native items below)

- [ ] `node scripts/test-native-offline.mjs --require-swift` — compiles & runs cache + sleep Swift regressions (incl. new `testEvictionEvictsMediaBeforeJSON`, `testEvictionOrderBudgetAndAgreement`, `testStorageIOFailureDegradesGracefully`).
- [ ] `node scripts/test-runtime-lyrics.mjs --require-swift` — NativeLyrics behavior.
- [ ] Once PR #48 merges: green macOS CI job is the standing gate for all future Swift changes.

## 1. Recovery & banner — PR #50 (issue #6), NativePlayback.swift

- [ ] Leave audio playing, background the app ~1–2 min, return → **no stale "load failed" banner** while audio is playing (scenario 1 of #6).
- [ ] Trigger a load failure (airplane mode), explicitly pause, restore connectivity → error does **not** reappear and audio does **not** auto-start (scenario 2).
- [ ] Slow-network start: normal buffering must NOT trigger reload spam; watch `playback.log` for `retry attempt=N` lines during merely-slow starts (buffer-empty KVO noise). If noisy, report — follow-up will gate on `waitingToPlayAtSpecifiedRate`.
- [ ] Recovery cap unchanged: after 8 failed retries → permanent stop with the existing user-facing message.

## 2. Reload reconciliation — PR #50 (issue #23)

- [ ] Use the in-app "重新加载页面" control, confirm → after reload the page recovers **track, queue, elapsed position, play/pause state** from the live native session; audible playback is never duplicated (no second audio session), paused stays paused.

## 3. Native cache limits & eviction — PRs #45 (issue #17) and #51 (issue #19 ruling 4)

- [ ] Pick a SMALLER cache limit in settings → eviction happens **immediately** (usage drops at once, not after next stats call).
- [ ] Start a download (play an uncached track), press Clear mid-download → cleared cache does not repopulate afterwards.
- [ ] Under budget pressure: audio bytes evict first, catalog/month JSON last (audio-first, metadata retained for cached audio; not mutual pinning).
- [ ] Reported usage equals actually-available entries (no "cached" rows that fail to play offline).
- [ ] Settings UI (#8, PR #45): four presets + selected value only; no internal path, no min–max range prose; web counterpart likewise.

## 4. Sleep — PR #46 (issues #26, #31)

- [ ] Drag the vertical sleep line during a running timer, hold the finger still for a few seconds → line does **not** drift or jump back (the original #26 symptom); release keeps the position; past-the-limit drags clamp at 1-minute remaining.
- [ ] With the phone locked: run a `hold`/`cliff`/`stair` preset → audible fade matches the previewed shape; playback fully stops at expiry.
- [ ] Cancel mid-fade, and play again after expiry → volume is restored (no lingering attenuation while playing).

## 5. Lyrics gesture — PR #43 (issue #27, already merged)

- [ ] While lyrics auto-scroll follows, keep a finger down and drag away → panel must not snap back mid-gesture even if the finger pauses; after sustained manual control (≥3 s) following stays OFF after release; "回到当前" restores it.

## 6. Narrow-screen UI — PR #47 (issues #10, #14)

- [ ] Long-press (~420 ms) a track card → grouped details panel appears (title/time/duration/offline as separate labeled lines); short tap still plays; tap-outside / × / back dismisses.
- [ ] Confirmed-unavailable track (offline, uncached) shows the **dashed outline**; unknown state does NOT; cached looks untouched.
- [ ] Offline with an uncached card over the compression strip → strip never shows through the card.

## 7. Prefetch while paused — PR #50 (issue #7)

- [ ] Play, pause, lose connectivity, reconnect while still paused → current + planned next track get cached silently (no auto-start, no banner); going offline again then playing both works from cache.

## 8. Baseline feature spot-check — PR #52 (release)

- [ ] Public site + app after #52: `/api/current` releaseId matches manifest; month blocks and audio Range 206 work in the app; offline cold start still plays a cached track (previously accepted, quick re-confirm on the released build).

---

Findings per item: comment on the owning PR (or #52 for the baseline). Failures block the
per-issue merge sequence only for the affected PR; others may merge independently.
