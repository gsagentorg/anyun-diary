import assert from 'node:assert/strict';
import {assertQueueBudget,queueSnapshotBytes} from '../src/lib/queue-budget.js';
const row={queueEntryId:'one',audio:{id:'audio',lyrics:[{t:0,text:'含歌词'}]}};const old=[row],before=JSON.stringify(old),bytes=queueSnapshotBytes(old);
assert.equal(assertQueueBudget([],old).bytes,bytes);
assert.throws(()=>assertQueueBudget(old,[row],{budget:bytes}),/原队列未修改/);assert.equal(JSON.stringify(old),before);
assert.doesNotThrow(()=>assertQueueBudget(old,[row],{replace:true,budget:bytes}));
assert.throws(()=>assertQueueBudget([],[{audio:{lyrics:[{text:'字'.repeat(200)}]}}],{budget:100}),/缩小日期范围/);
console.log('queue budget: byte accounting, repeated append, atomic rejection and replacement passed');
