import test from "node:test";
import assert from "node:assert/strict";
import {readFile,rm} from "node:fs/promises";
import {createMarketStore,prepareMarket,candidates,emaFor,warmupStart,expiryDiscoveryEnd} from "../src/market.js";
import {optimise,searchPlan,dimension,fastSearch} from "../src/optimiser.js";
import {createResultStore,compareResults} from "../src/results.js";
import {simulate} from "../src/engine.js";
import {fixture,cfg,day,start,bar} from "./fixtures.js";
import {sessionDateEpoch,ymdIST,addDays} from "../src/time.js";
const warmRows=date=>{let prior=addDays(date,-1);while([0,6].includes(new Date(`${prior}T00:00:00Z`).getUTCDay()))prior=addDays(prior,-1);return [0,1,2,3].map(i=>bar(sessionDateEpoch(prior,"15:10")+i*60,100));};
const opt={...cfg,mode:"EXHAUSTIVE",emaMin:2,emaMax:3,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:2,validMax:3,rrMin:1,rrMax:2,rrStep:1,lossMin:1,lossMax:2};
function provider(f=fixture()){
 const calls=new Map();const count=(name,args)=>{const key=name+JSON.stringify(args);calls.set(key,(calls.get(key)||0)+1)};
 return {calls,api:{
  async history(token,symbol,res,from,to){count("history",[symbol,res,from,to]);if(res==="5S")return from===day?f.data.monitor:[];return [...warmRows(day),...Array.from({length:360},(_,i)=>i===0?f.data.strategy.at(-1):bar(start+i*60,104))];},
  async expiryDates(token,...args){count("expiry",args);return {data:{expiry_dates:{options:["2026-09-22"]}}};},
  async expiredSymbols(token,...args){count("contracts",args);return {data:{expiry_date:"2026-09-22",contracts:{options:[{symbol:"NSE:NIFTY26922105CE",lot_size:50}]}}};},
  async expiredHistory(token,...args){count("options",args);return f.oc;}
 }};
}
test("deduplicate concurrent identical requests, including failed snapshots",async()=>{
 let calls=0;const store=createMarketStore("T",{history:async()=>{calls++;await new Promise(r=>setImmediate(r));return[];}});
 await Promise.all([store.history("x","1",day,day),store.history("x","1",day,day)]);assert.equal(calls,1);
 let failCalls=0;const failed=createMarketStore("T",{history:async()=>{failCalls++;throw new Error("unavailable");}});
 await Promise.allSettled([failed.history("x"),failed.history("x")]);assert.equal(failCalls,1);
});
test("optimiser prepares once, caches all FYERS resources, fixes resolution and ranks NET return",async t=>{
 const p=provider(),store=createMarketStore("T",p.api),progress=[];
 const r=await optimise("T",opt,{store,onProgress:s=>progress.push(s)});t.after(()=>rm(r.store.dir,{recursive:true,force:true}));
 assert.equal(r.status,"complete");assert.equal(r.processed,16);assert.equal(r.materialisedRows,16);assert.equal(r.exhaustive,true);assert.equal(r.resolution,"1");
 const page=await r.store.page(0);assert.equal(page.rows.length,16);assert.ok(page.rows.every(x=>x.resolution==="1"));assert.ok(page.rows.every((x,i)=>i===0||page.rows[i-1].totalReturnPct>=x.totalReturnPct));assert.deepEqual(r.best,page.rows[0]);
 assert.ok([...p.calls.values()].every(n=>n===1));assert.equal([...p.calls.keys()].filter(k=>k.startsWith("options")).length,1);
 const data=await prepareMarket(store,cfg);const detailed=await simulate(data,{...cfg,...r.best});assert.equal(detailed.summary.totalReturnPct,r.best.totalReturnPct);assert.ok([...p.calls.values()].every(n=>n===1));assert.ok(progress.some(s=>s.processed>=10));
});
const huge={...opt,emaMin:5,emaMax:300,slopeMin:1,slopeMax:50,validMin:1,validMax:20,rrMin:1,rrMax:10,rrStep:.5,lossMin:1,lossMax:20,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1,expiryType:"ALL"};
const objective=value=>({summary:{totalReturnPct:value,netPnl:value*1000,totalCharges:0,trades:1,ambiguousCount:0,incompleteData:false},skipped:[]});
const cleanup=(t,r)=>{if(r.store)t.after(()=>rm(r.store.dir,{recursive:true,force:true}));};
test("fixed weekly and 1m dimensions excluded; FAST search evaluates actual candidates with zero storage",async t=>{
 const plan=searchPlan(huge);assert.equal(plan.totalCombinations,112480000);assert.equal(plan.dimensions.some(d=>/resolution|expiry/i.test(d.name)),false);
 const r=await optimise("T",{...huge,mode:"FAST"},{data:fixture().data,maxBytes:0,fastLimit:50});cleanup(t,r);
 assert.equal(r.status,"complete");assert.equal(r.evaluated,50);assert.equal(r.requested,112480000);assert.equal(r.exhaustive,false);assert.equal(r.mode,"FAST");assert.ok(r.bestResult);assert.equal(r.storedResults,1);assert.equal(r.retentionLimited,true);
 assert.equal((await r.store.page()).rows[0].returnPct,r.bestResult.returnPct);
 assert.throws(()=>dimension(1,2,0,"EMA"),/positive/);assert.throws(()=>dimension(2,1,1,"EMA"),/max/);
});
test("large EXHAUSTIVE search starts with bounded retention and remains EXHAUSTIVE when cancelled",async t=>{
 const controller=new AbortController();
 const r=await optimise("T",huge,{data:fixture().data,maxBytes:0,signal:controller.signal,onProgress:s=>{if(s.evaluated>=10)controller.abort();}});cleanup(t,r);
 assert.equal(r.mode,"EXHAUSTIVE");assert.equal(r.status,"cancelled");assert.equal(r.evaluated,10);assert.equal(r.requested,112480000);assert.equal(r.exhaustive,false);assert.ok(r.bestResult);assert.equal(r.storedResults,1);
});
test("cancellation reports partial evaluation, keeps rows and never claims exhaustive",async t=>{
 const controller=new AbortController(),f=fixture();const r=await optimise("T",{...opt,lossMax:20},{data:f.data,signal:controller.signal,onProgress:s=>{if(s.processed>=10)controller.abort();}});t.after(()=>rm(r.store.dir,{recursive:true,force:true}));
 assert.equal(r.status,"cancelled");assert.equal(r.processed,10);assert.equal(r.exhaustive,false);assert.equal((await r.store.page(0)).rows.length,10);
});
test("missing required historical lots fail preparation before candidate evaluation",async t=>{
 const r=await optimise("T",{...opt,emaMax:2},{data:fixture({lotSize:null}).data});t.after(()=>rm(r.store.dir,{recursive:true,force:true}));assert.equal(r.status,"failed");assert.equal(r.evaluated,0);assert.match(r.reason,/Historical lot size unavailable/);
});
test("market snapshot rejects missing required 5S days/gaps; never substitutes minutes",async()=>{
 const f=fixture();f.data.monitor.splice(50,1);let p=provider(f);await assert.rejects(prepareMarket(createMarketStore("T",p.api),cfg),/5S HISTORY INCOMPLETE/);
 p=provider({...f,data:{...f.data,monitor:[]}});await assert.rejects(prepareMarket(createMarketStore("T",p.api),cfg),/NO 5S DATA RETURNED/);
});
test("selected Start/End bound trading and 5S requests; only strategy warmup precedes Start",async()=>{
 const p=provider(),calls=[];const original=p.api.history;p.api.history=async(token,symbol,res,from,to,opts)=>{calls.push({res,from,to});return original(token,symbol,res,from,to,opts);};
 const store=createMarketStore("T",p.api),data=await prepareMarket(store,{...cfg,resolution:"1"});
 assert.equal(data.strategyRangeStart,warmupStart(cfg.startDate,cfg.emaLength,cfg.slopeLookback,"1"));
 assert.ok(calls.some(x=>x.res==="1"&&x.from<cfg.startDate));
 assert.ok(calls.some(x=>x.res==="5S"&&x.from===cfg.startDate&&x.to===cfg.endDate));
 assert.ok(calls.filter(x=>x.res==="5S").every(x=>x.from>=cfg.startDate&&x.to<=cfg.endDate));
 assert.ok(calls.filter(x=>x.res==="1").every(x=>x.from<=cfg.endDate));
});
test("expiry discovery has a separate, minimal contract horizon without changing trading dates",()=>{
 assert.equal(expiryDiscoveryEnd("2026-09-30","WEEKLY"),"2026-10-08");
 assert.equal(expiryDiscoveryEnd("2026-09-30","MONTHLY"),"2026-10-31");
 assert.equal(expiryDiscoveryEnd("2026-09-30","ALL"),"2026-10-31");
});
test("near-present backtest routes unexpired expiry/contracts through active metadata and bounds expired lookup",async()=>{
 const today=ymdIST(Date.now()/1000);let tradeDate=addDays(today,-1);while([0,6].includes(new Date(`${tradeDate}T00:00:00Z`).getUTCDay()))tradeDate=addDays(tradeDate,-1);
 const expiry=addDays(today,3),expiryEpoch=sessionDateEpoch(expiry,"15:30"),expiryCalls=[],chainCalls=[];
 const store=createMarketStore("ACTIVE_CONTRACT_TEST",{
  async history(_token,_symbol,res,from){if(res==="5S")return Array.from({length:4321},(_,i)=>bar(sessionDateEpoch(tradeDate,"09:15")+i*5));return [...warmRows(tradeDate),...Array.from({length:360},(_,i)=>bar(sessionDateEpoch(tradeDate,"09:15")+i*60,100))];},
  async expiryDates(_token,_symbol,from,to){expiryCalls.push({from,to});return {data:{expiry_dates:{options:[]}}};},
  async optionChain(_token,_symbol,epoch){chainCalls.push(epoch);return epoch===undefined?{data:{expiryData:[{date:expiry.split("-").reverse().join("-"),expiry:String(expiryEpoch),expiry_flag:"W"}],optionsChain:[]}}:{data:{optionsChain:[{symbol:"NSE:NIFTY26O0825000CE",strike_price:25000,option_type:"CE"}]}};},
 });
 const data=await prepareMarket(store,{...cfg,startDate:tradeDate,endDate:tradeDate,expiryType:"WEEKLY"});
 assert.ok(expiryCalls.length);assert.ok(expiryCalls.every(x=>x.to<today));assert.deepEqual(chainCalls,[undefined,expiryEpoch]);
 assert.equal(data.classified.find(x=>x.date===expiry)?.type,"WEEKLY");assert.equal(data.contractsByExpiry.get(expiry)[0].symbol,"NSE:NIFTY26O0825000CE");
});
test("market preparation enforces 1m strategy data and separate 5S execution for stale inputs",async()=>{
 for(const resolution of ["1","5","15"]){
  const calls=[],store=createMarketStore("RESOLUTION_TEST",{
   async history(_token,symbol,res,from){calls.push({symbol,res,from});if(res==="5S")return Array.from({length:4321},(_,i)=>bar(start+i*5));
    return [...warmRows(day),...Array.from({length:360},(_,i)=>i===0?bar(start,99,103,98,102):bar(start+i*60,104))];},
   async expiryDates(){return {data:{expiry_dates:{options:[]}}};},async expiredSymbols(){return {data:{contracts:{options:[]}}};},async expiredHistory(){return {s:"ok",candles:[]};}
  });
  const prepared=await prepareMarket(store,{...cfg,resolution});
  assert.ok(calls.some(x=>x.res==="1"),"1m strategy requested");
  assert.ok(calls.some(x=>x.res==="5S"),"5S execution requested");assert.ok(!calls.some(x=>x.res==="5"||x.res==="15"),"stale resolution ignored");
  assert.equal(prepared.strategy.filter(x=>x.t>=start&&x.t<sessionDateEpoch(day,"15:15")).length,360);
  assert.equal(prepared.monitor.length,4321);
 }
});
test("no-data holidays are skipped without fabricating trades",async()=>{
 const store=createMarketStore("T",{history:async()=>[]});const data=await prepareMarket(store,cfg);assert.equal(data.noDataDays,true);assert.equal((await simulate(data,cfg)).trades.length,0);
});
test("disk-backed external merge sorts every row, paginates and exports without top-N truncation",async t=>{
 const store=await createResultStore();t.after(()=>rm(store.dir,{recursive:true,force:true}));
 for(let i=0;i<2205;i++)await store.add({combination:i+1,totalReturnPct:(i*17)%101,status:"EVALUATED"});
 await store.finalize();let all=[];for(let page=0;page<23;page++)all.push(...(await store.page(page)).rows);
 assert.equal(all.length,2205);assert.equal(new Set(all.map(x=>x.combination)).size,2205);assert.ok(all.every((x,i)=>i===0||all[i-1].totalReturnPct>=x.totalReturnPct));assert.equal((await readFile(store.file,"utf8")).trim().split("\n").length,2205);
 assert.equal((await store.page(23)).rows.length,0);
});
test("extra warm-up fetched for larger optimisation ranges cannot change a smaller parameter result",async()=>{
 const f=fixture(),extra=[bar(sessionDateEpoch("2026-08-01"),1000),bar(sessionDateEpoch("2026-08-02"),1)];
 const shared={...f.data,strategy:[...extra,...f.data.strategy],emas:new Map(),signals:new Map(),breakouts:new Map(),exits:new Map()};
 const a=await simulate(f.data,cfg),b=await simulate(shared,cfg);assert.deepEqual(b.trades,a.trades);assert.deepEqual(b.summary,a.summary);
});
test("actual runtime budget reports INCOMPLETE with evaluated counts and best retained",async t=>{
 const f=fixture();const r=await optimise("T",{...opt,lossMax:10000},{data:f.data,maxSeconds:.15,evaluate:async()=>{await new Promise(resolve=>setTimeout(resolve,5));return objective(10);}});cleanup(t,r);
 assert.equal(r.status,"incomplete");assert.ok(r.evaluated>0&&r.evaluated<r.requested);assert.equal(r.exhaustive,false);assert.match(r.reason,/Runtime budget/);assert.equal(r.bestResult.returnPct,10);
});
test("missing strategy history is not mistaken for a holiday when 5S exists",async()=>{
 const p=provider(),original=p.api.history;p.api.history=async(token,symbol,res,from,to,options)=>res==="5S"?original(token,symbol,res,from,to,options):warmRows(day);
 await assert.rejects(prepareMarket(createMarketStore("T",p.api),cfg),/Strategy candles unavailable/);
});

test("FAST is default and deterministically refines only on the exact stepped grid",async t=>{
 const input={...opt,mode:undefined,emaMin:5,emaMax:21,emaStep:2,slopeMax:3,validMax:3,rrMin:1,rrMax:2,rrStep:.25,lossMax:2,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1,expiryType:"ALL"};
 const evaluate=async(data,c)=>{assert.ok(c.emaLength>=5&&c.emaLength<=21&&(c.emaLength-5)%2===0);assert.ok(c.rr>=1&&c.rr<=2&&(c.rr-1)/.25%1===0);assert.equal(c.resolution,"1");assert.equal(c.optionResolution,"1");return objective(100-Math.abs(c.emaLength-13)-Math.abs(c.slopeLookback-2)-Math.abs(c.rr-1.5));};
 const stages=[],a=await optimise("T",input,{data:fixture().data,evaluate,fastLimit:1500,onProgress:s=>stages.push(s.stage)}),b=await optimise("T",input,{data:fixture().data,evaluate,fastLimit:1500});cleanup(t,a);cleanup(t,b);
 assert.equal(a.mode,"FAST");assert.equal(a.exhaustive,false);assert.ok(stages.some(x=>x.startsWith("Refinement")));assert.deepEqual(a.bestResult,b.bestResult);assert.equal(a.bestResult.emaLength,13);assert.equal(a.bestResult.slopeLookback,2);assert.equal(a.bestResult.rr,1.5);
 const plan=searchPlan(input),search=fastSearch(plan,100),seen=new Set();let next=search.next();while(!next.done){const key=JSON.stringify(next.value.parameters);assert.ok(!seen.has(key));seen.add(key);next=search.next({eligible:true,returnPct:1,...next.value.parameters});}assert.equal(seen.size,100);
});
test("online best retains all winning parameters and survives result retention exhaustion",async t=>{
 const input={...opt,emaMin:10,emaMax:12,slopeMin:3,slopeMax:3,validMin:4,validMax:4,rrMin:6,rrMax:6,lossMin:8,lossMax:8,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1,expiryType:"MONTHLY"};
 const r=await optimise("T",input,{data:fixture().data,maxBytes:1,evaluate:async(data,c)=>objective({10:10,11:18,12:14}[c.emaLength])});cleanup(t,r);
 assert.equal(r.evaluated,3);assert.equal(r.requested,3);assert.equal(r.exhaustive,true);assert.equal(r.status,"complete");
 const b=r.bestResult;assert.equal(b.returnPct,18);assert.equal(b.emaLength,11);assert.equal(b.slopeLookback,3);assert.equal(b.entryValidCandles,4);assert.equal(b.rr,6);assert.equal(b.maxConsecutiveLossesPerDay,8);assert.equal(b.minStopLossDistancePct,0);assert.equal(b.expiryType,"WEEKLY");assert.equal(r.storedResults,1);assert.equal((await r.store.page()).rows[0].emaLength,11);
});
test("ties choose lower parameters then DAILY/WEEKLY/MONTHLY independent of arrival order",()=>{
 const rows=[{emaLength:10,slopeLookback:2,entryValidCandles:3,rr:4,maxConsecutiveLosses:5,expiryType:"MONTHLY",returnPct:18},
 {emaLength:10,slopeLookback:2,entryValidCandles:3,rr:4,maxConsecutiveLosses:5,expiryType:"WEEKLY",returnPct:18},
 {emaLength:9,slopeLookback:7,entryValidCandles:3,rr:4,maxConsecutiveLosses:5,expiryType:"MONTHLY",returnPct:18}];
 const best=list=>list.reduce((b,row)=>!b||compareResults(row,b)<0?row:b,null);
 assert.equal(best(rows).emaLength,9);assert.deepEqual(best(rows),best([...rows].reverse()));assert.equal(best(rows.slice(0,2)).expiryType,"WEEKLY");
});
test("EMA, signal pairs, first breakout and contract selections are reused across RR/guard/validity",async()=>{
 const data=fixture().data,context={...cfg,emaSeedDate:"2026-09-01"};
 const signals=candidates(data,context),ema=emaFor(data,context).values;
 for(const rr of [1,2])for(const maxConsecutiveLosses of [1,2])for(const entryValidCandles of [2,3])await simulate(data,{...context,rr,maxConsecutiveLosses,entryValidCandles});
 assert.equal(candidates(data,context),signals);assert.equal(emaFor(data,context).values,ema);assert.equal(data.cacheStats.emaCalculations,1);assert.equal(data.cacheStats.signalCalculations,1);assert.equal(data.cacheStats.breakoutScans,1);assert.equal(data.cacheStats.contractSelections,1);
 candidates(data,{...context,slopeLookback:2});assert.equal(data.cacheStats.emaCalculations,1);assert.equal(data.cacheStats.signalCalculations,2);assert.equal(candidates(data,context),signals);
});
test("both modes evaluate with the detailed simulator, fixed resolution, and recorded EMA seed",async t=>{
 for(const mode of ["FAST","EXHAUSTIVE"]){
  const data=fixture().data,r=await optimise("T",{...opt,mode,emaMax:2},{data});cleanup(t,r);
  const detailed=await simulate(fixture().data,{...r.config,...r.bestResult});assert.equal(r.bestResult.returnPct,detailed.summary.totalReturnPct);assert.equal(r.config.resolution,"1");assert.equal(r.config.optionResolution,"1");assert.equal(r.cacheStats.emaCalculations,1);
 }
});
test("cache memory exhaustion is explicit INCOMPLETE, not silent recomputation",async t=>{
 const r=await optimise("T",opt,{data:fixture().data,cacheBudget:1});cleanup(t,r);assert.equal(r.status,"incomplete");assert.match(r.reason,/cache reached its memory budget/);assert.equal(r.exhaustive,false);
});
test("storage errors cannot stop evaluating or lose online best",async()=>{
 let count=0;const r=await optimise("T",{...opt,emaMax:2},{data:fixture().data,resultStore:{add:async()=>{throw new Error("disk full");}},evaluate:async()=>objective(++count)});
 assert.equal(r.status,"complete");assert.equal(r.evaluated,r.requested);assert.equal(r.bestResult.returnPct,count);assert.equal(r.storedResults,1);assert.equal(r.exportAvailable,false);assert.match(r.retentionWarning,/evaluation continues/);
});
test("decimal range steps do not quantize winning parameter values",()=>{
 const range=dimension(1.000000001,1.000000003,.000000001,"RR");assert.equal(range.count,3);assert.equal(range.value(1),1.000000002);
});
