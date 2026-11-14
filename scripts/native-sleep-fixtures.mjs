import { writeFileSync } from 'node:fs';
import { SLEEP_MODES, sleepGain } from '../src/lib/sleep-curves.ts';
const cases = SLEEP_MODES.flatMap(({ id }) => Array.from({ length: 200 }, (_, i) => ({ mode: id, progress: i / 200, gain: sleepGain(id, i / 200) })));
writeFileSync(process.argv[2], JSON.stringify(cases));
