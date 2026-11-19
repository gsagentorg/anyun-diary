import {configuredStore} from '../src/lib/server/storage.mjs';
import {rollbackRelease} from '../src/lib/server/publisher.mjs';
try{if(process.argv.length!==3)throw Error('Expected release ID');const m=await rollbackRelease(configuredStore(process.env),process.argv[2]);console.log(JSON.stringify({revision:m.revision}));}catch{console.error('Rollback failed; verify release and storage configuration. Re-read current before retry.');process.exitCode=1;}
