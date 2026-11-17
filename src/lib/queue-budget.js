// Local Chromium benchmark: 3.77 MB lyric snapshots stringify/UTF8/parse in
// 15.5ms median, 19.7ms max; 7.55 MB takes 28.4ms / 34.5ms.
// Stay below the former envelope, with margin for queue IDs and session fields.
// This is a byte budget, never a silent track-count truncation.
export const QUEUE_SNAPSHOT_BUDGET_BYTES=3*1024*1024;
const encoder=new TextEncoder();
export function queueSnapshotBytes(rows){return encoder.encode(JSON.stringify(rows)).length;}
export function assertQueueBudget(existing,incoming,{replace=false,budget=QUEUE_SNAPSHOT_BUDGET_BYTES}={}){
 let bytes=2,count=0;
 for(const rows of replace?[incoming]:[existing,incoming])for(const row of rows){bytes+=queueSnapshotBytes(row)+(count++?1:0);if(bytes>budget)throw Error('队列快照超过安全内存预算，请缩小日期范围或先清理队列（原队列未修改）');}
 return {bytes,count};
}
