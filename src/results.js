import {mkdtemp,writeFile,open,unlink} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
const EXPIRY_ORDER={DAILY:0,WEEKLY:1,MONTHLY:2};
// One ordering for online best, FAST refinement regions and retained result rows.
// Exact return ties: smaller EMA, slope, validity, RR, daily guard, then stop-distance.
export function compareResults(a,b){
  const score=(b.returnPct??b.totalReturnPct??-Infinity)-(a.returnPct??a.totalReturnPct??-Infinity);
  if(score)return score;
  for(const key of ["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses","minStopLossDistancePct"]){
    const difference=(a[key]??0)-(b[key]??0);if(difference)return difference;
  }
  return (EXPIRY_ORDER[a.expiryType]??3)-(EXPIRY_ORDER[b.expiryType]??3)||(a.combination??0)-(b.combination??0);
}
async function merge(paths,target){
  const streams=paths.map(path=>createReadStream(path)),readers=streams.map(input=>createInterface({input,crlfDelay:Infinity})),iterators=readers.map(r=>r[Symbol.asyncIterator]());
  const heads=await Promise.all(iterators.map(i=>i.next())),out=await open(target,"w");
  let buffer="";
  try{
    while(true){let selected=-1,row;
      for(let i=0;i<heads.length;i++){if(heads[i].done)continue;const next=JSON.parse(heads[i].value);if(selected<0||compareResults(next,row)<0){selected=i;row=next;}}
      if(selected<0)break;
      buffer+=JSON.stringify(row)+"\n";if(buffer.length>=65536){await out.writeFile(buffer);buffer="";}heads[selected]=await iterators[selected].next();
    }
    if(buffer)await out.writeFile(buffer);
  }finally{readers.forEach(r=>r.close());streams.forEach(s=>s.destroy());await out.close();}
}
export async function createResultStore({maxBytes=Infinity}={}){
  const dir=await mkdtemp(join(tmpdir(),"fyers-results-")),runs=[];
  let buffer=[],count=0,bytes=0,serial=0,index=[],file=null,limited=false,lastRetained=0;
  async function flush(){if(!buffer.length)return;buffer.sort(compareResults);const path=join(dir,`${serial++}.ndjson`);await writeFile(path,buffer.map(r=>JSON.stringify(r)).join("\n")+"\n");runs.push(path);buffer=[];}
  async function append(row){count++;bytes+=Buffer.byteLength(JSON.stringify(row))+1;buffer.push(row);if(buffer.length>=1000)await flush();}
  return {
    get count(){return count;},get bytes(){return bytes;},get file(){return file;},get limited(){return limited;},dir,
    contains(row){return !!row&&row.combination<=lastRetained;},
    async add(row){
      if(limited||bytes+Buffer.byteLength(JSON.stringify(row))+1>maxBytes){limited=true;return false;}
      await append(row);lastRetained=row.combination;return true;
    },
    async finalize(bestResult){
      // Disk retention is a prefix of evaluated rows plus a reserved best row.
      // Even a zero-byte retention budget cannot prevent best-result discovery.
      if(bestResult&&bestResult.combination>lastRetained)await append(bestResult);
      await flush();if(!runs.length){file=join(dir,"empty.ndjson");await writeFile(file,"");return;}
      let current=[...runs];
      while(current.length>1){const next=[];for(let i=0;i<current.length;i+=32){const group=current.slice(i,i+32),target=join(dir,`${serial++}.ndjson`);await merge(group,target);await Promise.all(group.map(p=>unlink(p)));next.push(target);}current=next;}
      file=current[0];let offset=0,n=0;index=[];
      const input=createReadStream(file),lines=createInterface({input,crlfDelay:Infinity});
      for await(const line of lines){if(n++%100===0)index.push(offset);offset+=Buffer.byteLength(line)+1;}
    },
    async page(page=0){
      if(!file)throw new Error("Result sorting is not finished");
      if(!Number.isSafeInteger(page)||page<0)throw new Error("Invalid page");
      if(page>=index.length)return {rows:[],page,pageSize:100,totalRows:count};
      const handle=await open(file,"r"),rows=[];let position=index[page],pending="";
      try{while(rows.length<100){const buf=Buffer.alloc(65536),{bytesRead}=await handle.read(buf,0,buf.length,position);if(!bytesRead)break;position+=bytesRead;pending+=buf.subarray(0,bytesRead).toString("utf8");let newline;while(rows.length<100&&(newline=pending.indexOf("\n"))>=0){rows.push(JSON.parse(pending.slice(0,newline)));pending=pending.slice(newline+1);}}}finally{await handle.close();}
      return {rows,page,pageSize:100,totalRows:count};
    }
  };
}
