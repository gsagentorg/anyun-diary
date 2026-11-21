#!/usr/bin/env node
// Source checks everywhere; on macOS compile the real NativeSleep and compare its output
// against the actual TS sleepGain (not a JavaScript port of Swift).
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, 'ios/App/App/NativeSleep.swift'), 'utf8');
const web = readFileSync(join(root, 'src/lib/sleep-curves.ts'), 'utf8');
let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
for (const part of ['0.24 * t * t * t', 't < 0.82 ? 0 : 0.2 * smooth(min(1, (t - 0.82) / 0.15))', '[0, 0.1, 0.2, 0.3]', 'floor(t / 0.25)', '(local - 0.9) / 0.1', '["cliff", "hold", "stair"].contains(mode)', 'progress.isFinite', 'if t >= 1 { return 0 }', 'Self.gain(mode: mode']) ok(source.includes(part), 'NativeSleep formula: ' + part);
for (const mode of ['cliff', 'hold', 'stair']) ok(web.includes("'" + mode + "'"), 'Web mode exists: ' + mode);
console.log('native-sleep: ' + checks + ' static contracts passed (NOT Swift execution)');
const compiler = process.platform === 'darwin' ? spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }) : null;
if (!compiler || compiler.status !== 0) {
  console.log('SKIP: macOS Swift unavailable; native sleep behavior/compilation UNVERIFIED.');
  if (process.argv.includes('--require-swift')) process.exitCode = 1;
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'anyun-native-sleep-'));
  try {
    const modes = ['gentle', 'steady', 'companion', 'late', 'cliff', 'hold', 'stair', 'off'];
    const edges = [0, .225, .25, .475, .5, 2/3, .725, .75, .82, .9, .94, .96, .97, .98, 1];
    const points = [...new Set([-1, 2, ...Array.from({ length: 1001 }, (_, i) => i/1000), ...edges.flatMap(t => [t-1e-10, t, t+1e-10])])];
    const swift = join(temporary, 'main.swift');
    writeFileSync(swift, 'import Foundation\n' +
      'let modes = ' + JSON.stringify(modes) + '\nlet points: [Double] = ' + JSON.stringify(points) + '\n' +
      'for mode in modes { for t in points { print(NativeSleep.gain(mode: mode, progress: t)) } }\n' +
      'for mode in modes { for t in [Double.nan, Double.infinity, -Double.infinity] { precondition(NativeSleep.gain(mode: mode, progress: t) == 1) } }\n' +
      'var state = NativeSleep(); state.configure(revision: "one", until: 1000, started: 0, mode: "hold", afterTrack: false)\n' +
      'precondition(!state.decision(at: 999).stop && state.decision(at: 999).gain > 0.25)\n' +
      'precondition(state.decision(at: 1000).stop && state.decision(at: 1000).gain == 0)\n' +
      'state.configure(revision: "one", until: 2000, started: 0, mode: "off", afterTrack: true); precondition(state.until == 1000 && !state.afterTrack)\n' +
      'state.finish(); precondition(state.fired && state.until == nil && !state.afterTrack)\n');
    const executable = join(temporary, 'sleep-tests');
    const compiled = spawnSync(compiler.stdout.trim(), ['ios/App/App/NativeSleep.swift', swift, '-o', executable], { cwd: root, encoding: 'utf8', timeout: 90000 });
    process.stdout.write(compiled.stdout || ''); process.stderr.write(compiled.stderr || '');
    assert.equal(compiled.status, 0, 'Swift compile failed; no automatic retry');
    const native = spawnSync(executable, [], { encoding: 'utf8', timeout: 30000 });
    process.stderr.write(native.stderr || '');
    assert.equal(native.status, 0, 'Swift behavior failed');
    // Vite loads the repository TypeScript unchanged.
    const oracle = join(temporary, 'oracle.mjs');
    writeFileSync(oracle, 'import { sleepGain } from ' + JSON.stringify(join(root, 'src/lib/sleep-curves.ts')) + ';\n' +
      'console.log(JSON.stringify(' + JSON.stringify(modes) + '.flatMap(mode => ' + JSON.stringify(points) + '.map(t => sleepGain(mode, t)))));\n');
    const expected = spawnSync(join(root, 'node_modules/.bin/vite-node'), [oracle], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(expected.status, 0, expected.stderr);
    const values = native.stdout.trim().split(/\s+/).map(Number), targets = JSON.parse(expected.stdout.trim());
    assert.equal(values.length, targets.length);
    values.forEach((value, i) => assert.ok(Math.abs(value-targets[i]) <= 1e-12, 'Swift/TS gain mismatch at ' + i));
    console.log('native-sleep: ' + values.length + ' actual Swift/TS boundary+grid comparisons passed; wall-clock/revision/finish assertions passed.');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
