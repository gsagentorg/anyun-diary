import {monthIdAt,monthBounds,selectMonths} from '../month.js';
export {MONTH_BOUNDARY_DAY,monthBounds} from '../month.js';
export const monthId=monthIdAt;
export function maxQueryMonths(value='0'){const n=Number(value);if(!Number.isInteger(n)||n<0)throw Error('Invalid MAX_QUERY_MONTHS');return n;}
export function queryMonths(months,now,max=0){return selectMonths({months},{now,maxMonths:max}).filter(m=>m.available).sort((a,b)=>b.startAt-a.startAt);}
