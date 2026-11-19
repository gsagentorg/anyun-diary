/** A component-owned operation: cancellation invalidates even non-cooperative promises. */
export function createLatestOperation(){
 let current;
 function cancel(){current?.abort();current=undefined;}
 async function run(work,commit){cancel();const c=new AbortController();current=c;try{const value=await work(c.signal,callback=>(...args)=>{if(current===c&&!c.signal.aborted)callback(...args);});if(current!==c||c.signal.aborted)return;commit(value);return value;}finally{if(current===c)current=undefined;}}
 return {cancel,run};
}
