import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
async function walk(dir) { const result=[]; for (const e of await readdir(dir,{withFileTypes:true})) {const p=path.join(dir,e.name); if(e.isDirectory())result.push(...await walk(p)); else if(/\.(ts|js|svelte)$/.test(e.name))result.push(p);} return result; }
const files=await walk(fileURLToPath(new URL('../src',import.meta.url)));
for(const file of files){const source=await readFile(file,'utf8');assert(!/\bRecording\b|buildRecTracks|recordings\[|recordings:|presignGet|@aws-sdk|s3-presign|\$lib\/data\.json/.test(source), 'old data path: '+file);}
const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
assert(!pkg.dependencies?.['@aws-sdk/client-s3']);
assert(!/build_data|upload-blob|migrate-audio/.test(JSON.stringify(pkg.scripts)));
console.log('architecture: source imports and npm scripts contain no legacy full catalog / recording / signing path');
