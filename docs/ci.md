# CI (`.github/workflows/ci.yml`)

Two jobs, both on pull requests targeting `feat/public-v2` / `main`, pushes to
`feat/public-v2`, and manual `workflow_dispatch`.

## `linux` — `ubuntu-latest`

`npm ci` → `npm run check` → `npm test` (the full 24-step chain).

Every step is self-contained: browsers, S3 and network are replaced by fixtures and
mocks, so no secrets or services are needed.

**Architecture gate:** `test:architecture` rejects the orphaned `upload-blob`
scripts; PR #42 removed them from `package.json`, so this job is expected green
on top of current `main`.

## `macos` — `macos-latest`

This job exists for one reason: the iOS `--require-swift` variants only compile and
execute Swift on macOS. On Linux they print `SKIP: ... UNVERIFIED` and check source
contracts only. `--require-swift` makes a missing toolchain exit non-zero, so this job
is a real release gate rather than a silent pass.

Steps: `npm ci` → `xcrun --find swiftc` → pin `SDKROOT` (`xcrun --sdk macosx
--show-sdk-path`) → `npm run check` →
`npm run test:native-offline:required` → `npm run test:runtime-lyrics:required` →
the orphaned `scripts/test-native-retry.swift` compiled and run directly.

`SDKROOT` is exported to `$GITHUB_ENV` because the wrappers spawn `swiftc`
directly without `-sdk`; without it the driver can choose a mismatched target
(`arm64-apple-macosx26.0`) and fail to load the standard library.

What the required variants actually execute:

| Entry point | Swift files compiled and run |
| --- | --- |
| `test:native-offline:required` | `AnyunCacheConstants/Network/DiskCache/PlaybackCache/SchemeHandler` + `scripts/test-native-cache.swift`, and (via `test-native-sleep.mjs --require-swift`) `NativeSleep.swift` + `scripts/test-native-sleep.swift` with TS-generated fixtures |
| `test:runtime-lyrics:required` | `NativeLyrics.swift` + `scripts/test-native-lyrics.swift` |
| retry step (added here) | `NativeRetry.swift` + `scripts/test-native-retry.swift` |

`scripts/test-native-retry.swift` has no wrapper or npm script, so CI invokes it
directly; if it is later wired into an npm script, replace that step with the script.
