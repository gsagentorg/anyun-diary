#!/usr/bin/env node
// Real TS oracle + real Foundation-only Swift execution. Never label source checks Swift verification.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, 'ios/App/App/NativeSleep.swift'), 'utf8');
const playback = readFileSync(join(root, 'ios/App/App/NativePlayback.swift'), 'utf8');
for(const part of ['0.24 * t * t * t','floor(t / 0.25)','progress.isFinite','if t >= 1 { return 0 }','Self.gain(mode: mode','mode == "custom"','min(custom.tailPercent / 100, (1 - hold) / 2)','custom.endDb * pow(u, custom.exponent)','guard revision != self.revision','self.custom = custom','CFBooleanGetTypeID']) assert.ok(source.includes(part), part);
for(const part of ['"supportsCustomSleep": true','"sleepCustomVersion": 1','"sleepCustom": sleepState.custom.dictionary','NativeSleepCustom.decode(saved["sleepCustom"]','NativeSleepCustom.decode(call.getObject("sleepCustom")','version: saved["sleepCustomVersion"]','version: call.getInt("sleepCustomVersion")']) assert.ok(playback.includes(part),part);
console.log('native-sleep: formula/capability/bridge/persistence source contracts passed (NOT Swift execution)');
let compiler = process.platform === 'darwin' ? spawnSync('xcrun',['--find','swiftc'],{encoding:'utf8'}) : spawnSync('sh',['-c','command -v swiftc'],{encoding:'utf8'});
if(compiler.status!==0 || !compiler.stdout.trim()) {
  console.log('SKIP: Swift compiler unavailable; native sleep behavior/compilation UNVERIFIED.');
  if(process.argv.includes('--require-swift')) process.exitCode=1;
} else {
  const temporary=mkdtempSync(join(tmpdir(),'anyun-native-sleep-'));
  const run=(command,args)=>{const result=spawnSync(command,args,{cwd:root,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');assert.equal(result.status,0,'failed: '+command);return result;};
  try {
    const fixtures=join(temporary,'fixtures.json'), executable=join(temporary,'sleep-tests');
    run(join(root,'node_modules/.bin/vite-node'),['scripts/native-sleep-fixtures.mjs',fixtures]);
    run(compiler.stdout.trim(),['ios/App/App/NativeSleep.swift','scripts/test-native-sleep.swift','-o',executable]);
    run(executable,[fixtures]);
    console.log('native-sleep: actual Swift/TS grid, edges, version/restore/revision/cancel/expiry tests passed. This does NOT compile the AVFoundation/Capacitor App target.');
  } finally {rmSync(temporary,{recursive:true,force:true});}
}
