import { writeFileSync } from 'node:fs';
import { SLEEP_MODES, sleepGain, DEFAULT_SLEEP_CUSTOM, sleepCustomWindow } from '../src/lib/sleep-curves.ts';
const cases = [];
function append(mode, custom) {
  const { hold, tail } = sleepCustomWindow(custom);
  const edges = [0, .225, .25, .475, .5, 2/3, .725, .75, .82, .9, .94, .96, .97, .98, 1, hold, 1-tail];
  const points = [...new Set([-1, 2, ...Array.from({length:1001},(_,i)=>i/1000), ...edges.flatMap(t=>[t-1e-10,t,t+1e-10])])];
  for (const progress of points) cases.push({ mode, custom, progress, gain:sleepGain(mode,progress,custom) });
}
for(const {id} of SLEEP_MODES) append(id,{...DEFAULT_SLEEP_CUSTOM});
for(const holdPercent of [0,30,90]) for(const endDb of [-60,-24,0]) for(const exponent of [.25,2,4]) for(const tailPercent of [0,10,30]) append('custom',{holdPercent,endDb,exponent,tailPercent});
writeFileSync(process.argv[2], JSON.stringify(cases));
