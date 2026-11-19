export const DATA_PERIOD_START_DAY = 7;
export const MONTH_BOUNDARY_DAY = DATA_PERIOD_START_DAY;
export const MONTH_TIMEZONE = 'Asia/Shanghai';
const OFFSET = 28800;
export function shiftMonthId(id, delta) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(id) || !Number.isInteger(delta)) throw new Error('Invalid month');
  const [y,m] = id.split('-').map(Number), d = new Date(Date.UTC(y,m-1+delta,1));
  return d.getUTCFullYear().toString().padStart(4,'0')+'-'+String(d.getUTCMonth()+1).padStart(2,'0');
}
export function monthBounds(id) {
  shiftMonthId(id,0);
  const boundary = v => { const [y,m]=v.split('-').map(Number); return Date.UTC(y,m-1,MONTH_BOUNDARY_DAY)/1000-OFFSET; };
  return { id, startAt: boundary(id), endAt: boundary(shiftMonthId(id,1)) };
}
export function monthIdAt(epoch) {
  if (!Number.isFinite(epoch)) throw new Error('Invalid timestamp');
  const d=new Date((epoch+OFFSET)*1000), id=d.getUTCFullYear().toString().padStart(4,'0')+'-'+String(d.getUTCMonth()+1).padStart(2,'0');
  return d.getUTCDate()<MONTH_BOUNDARY_DAY ? shiftMonthId(id,-1) : id;
}
export function subtractCalendarMonths(epoch, months) {
  if (!Number.isInteger(months)||months<0||!Number.isFinite(epoch)) throw new Error('Invalid rolling window');
  const d=new Date((epoch+OFFSET)*1000), y=d.getUTCFullYear(), m=d.getUTCMonth()-months;
  const last=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  return Date.UTC(y,m,Math.min(d.getUTCDate(),last),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds(),d.getUTCMilliseconds())/1000-OFFSET;
}
export function selectMonths(manifest,{now=Date.now()/1000,maxMonths=0,startAt=-Infinity,endAt=Infinity}={}) {
  if (!Number.isInteger(maxMonths)||maxMonths<0) throw new Error('Invalid maxMonths');
  const current=monthIdAt(now), lower=maxMonths?monthBounds(shiftMonthId(current,1-maxMonths)).startAt:-Infinity, upper=maxMonths?monthBounds(current).endAt:Infinity;
  return manifest.months.filter(m=>m.endAt>Math.max(startAt,lower)&&m.startAt<Math.min(endAt,upper)).sort((a,b)=>a.startAt-b.startAt);
}
