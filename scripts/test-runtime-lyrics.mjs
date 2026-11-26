#!/usr/bin/env node
// Cleanup behavior/source contracts run everywhere. Swift behavior runs on macOS;
// --require-swift fails rather than treating an unavailable compiler as a pass.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, 'ios/App/App/NativeLyrics.swift'), 'utf8');
const cleanup = readFileSync(join(root, 'scripts/sync-native-lyrics.mjs'), 'utf8');
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90000, ...options });
  if (result.error) throw result.error;
  return result;
}
function passed(result, message) {
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, message + ' (no automatic retry)'); checks++;
}
const implementation = source.replace(/\/\/[^\n]*/g, '');
ok(!/Bundle|contentsOf|URLSession|FileManager|catalog|bundled/.test(implementation), 'hydration has no bundle/filesystem/network/catalog dependency');
ok(!implementation.includes('item["id"]') && !implementation.includes('item["title"]') && !implementation.includes('item["startAt"]'), 'hydration never matches identity, title or date');
ok(implementation.includes('static func hydrate(_ items: [[String: Any]])') && implementation.includes('item["audio"]') && implementation.includes('audio["lyrics"]'), 'existing single-argument API repairs from the entry runtime snapshot');
ok(!/readFile|writeFile|fetch\s*\(|data\.json|recordings|readdir/.test(cleanup), 'compatibility hook cannot read catalog data, fetch, generate or recursively delete');
ok(cleanup.includes("import { unlink }") && cleanup.includes("new URL('../static/native-lyrics.json', import.meta.url)"), 'cleanup targets only the exact obsolete generated file');

const swiftTests = readFileSync(join(root, 'scripts/test-native-lyrics.swift'), 'utf8');

const temporary = mkdtempSync(join(tmpdir(), 'anyun-runtime-lyrics-'));
try {
  // Copy only executable code into a synthetic tree. No real catalog is read or changed.
  const scripts = join(temporary, 'scripts');
  const staticDir = join(temporary, 'static');
  mkdirSync(scripts); mkdirSync(staticDir);
  const hook = join(scripts, 'sync-native-lyrics.mjs');
  writeFileSync(hook, cleanup);
  const artifact = join(staticDir, 'native-lyrics.json');
  const sentinel = join(staticDir, 'unrelated.json');
  writeFileSync(sentinel, 'synthetic neighbor');
  writeFileSync(artifact, '{"synthetic":[]}');
  passed(run(process.execPath, [hook], { cwd: tmpdir() }), 'old artifact cleanup with no legacy data file');
  ok(!existsSync(artifact) && readFileSync(sentinel, 'utf8') === 'synthetic neighbor', 'only generated file removed, independent of cwd');
  mkdirSync(join(temporary, 'src', 'lib', 'data.json'), { recursive: true }); // a catalog read would fail
  passed(run(process.execPath, [hook]), 'cleanup is idempotent even if the data path is unreadable');
  ok(!existsSync(artifact), 'compatibility hook never regenerates runtime data');
  symlinkSync(sentinel, artifact);
  passed(run(process.execPath, [hook]), 'generated symlink cleanup');
  ok(readFileSync(sentinel, 'utf8') === 'synthetic neighbor', 'unlink never follows generated symlink');
  mkdirSync(artifact);
  writeFileSync(join(artifact, 'keep.txt'), 'directory sentinel');
  const refused = run(process.execPath, [hook]);
  ok(refused.status !== 0, 'unexpected generated-path directory is refused, not recursively deleted');
  ok(readFileSync(join(artifact, 'keep.txt'), 'utf8') === 'directory sentinel', 'directory contents preserved after refusal');
  console.log('runtime-lyrics: ' + checks + ' cleanup/source contracts passed (NOT Swift execution)');

  const compiler = process.platform === 'darwin' ? run('xcrun', ['--find', 'swiftc']) : null;
  if (!compiler || compiler.status !== 0) {
    console.log('SKIP: macOS Swift unavailable; NativeLyrics compilation/behavior and iPhone lock-screen playback remain UNVERIFIED.');
    if (process.argv.includes('--require-swift')) process.exitCode = 1;
  } else {
    const fixture = join(temporary, 'RuntimeLyricsTests.swift');
    const executable = join(temporary, 'runtime-lyrics-tests');
    writeFileSync(fixture, swiftTests);
    passed(run(compiler.stdout.trim(), ['-swift-version', '5', '-parse-as-library', join(root, 'ios/App/App/NativeLyrics.swift'), fixture, '-o', executable]), 'NativeLyrics Swift compile');
    passed(run(executable, []), 'NativeLyrics Swift behavior');
    console.log('runtime-lyrics: macOS Swift passed; iOS App target/device validation remains separate.');
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
