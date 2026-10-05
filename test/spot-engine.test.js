import test from "node:test";
import assert from "node:assert/strict";
import {runSpotBacktest,normalizeSpot,prepareSpotData,backtestSpot,spotWarmupStart} from "../src/spot-engine.js";
import {sessionDateEpoch,ymdIST} from "../src/time.js";
import {spotSearchPlan,spotCandidates,optimiseSpot,compareSpot} from "../src/spot-optimiser.js";

const day="2026-06-01",start=sessionDateEpoch(day,"09:15");
function fixture({side="BUY",type="A",breakout=true,exit="EOD",ambiguous=false,valid=2}={}){
  const warm=Array.from({length:4},(_,i)=>({t:start-240+(i*60),o:100,h:101,l:99,c:100,v:1}));
  const rows=Array.from({length:360},(_,i)=>({t:start+i*60,o:100,h:101,l:99,c:100,v:1}));
  const si=10,sc=rows[si];let signal;
  if(side==="BUY"&&type==="A"){Object.assign(sc,{o:99,h:102,l:98,c:101});signal={side:"BUY",type:"A"};}
  if(side==="BUY"&&type==="B"){Object.assign(sc,{o:101,h:103,l:99,c:102});signal={side:"BUY",type:"B"};}
  if(side==="SELL"&&type==="A"){Object.assign(sc,{o:101,h:102,l:98,c:99});signal={side:"SELL",type:"A"};}
  if(side==="SELL"&&type==="B"){Object.assign(sc,{o:99,h:101,l:97,c:98});signal={side:"SELL",type:"B"};}
  if(breakout){const b=rows[si+1];if(side==="BUY")Object.assign(b,{o:100,h:104,l:ambiguous?97:100,c:103});else Object.assign(b,{o:100,h:ambiguous?103:100,l:96,c:97});}
  if(exit==="TARGET"){const x=rows[si+2];Object.assign(x,side==="BUY"?{o:104,h:120,l:100,c:115}:{o:96,h:100,l:80,c:85});}
  if(exit==="SL"){const x=rows[si+2];Object.assign(x,side==="BUY"?{o:100,h:101,l:97,c:98}:{o:100,h:103,l:99,c:102});}
  if(ambiguous){const b=rows[si+1];Object.assign(b,side==="BUY"?{o:100,h:110,l:97,c:100}:{o:100,h:103,l:90,c:100});}
  const candles=[...warm,...rows],ema=Array(candles.length).fill(100),ix=warm.length+si;ema[ix]=100;ema[ix-1]=side==="BUY"?99:101;
  const data={candles,emaCache:new Map([[20,ema]]),signalCache:new Map(),warmupStart:day,historyRequests:{oneMinuteRequests:1,networkHistoryRequests:1,execution5sRequests:0,expiryRequests:0,optionHistoryRequests:0}};
  return {data,cfg:{symbol:"NIFTY",startDate:day,endDate:day,resolution:"1",emaLength:20,slopeLookback:1,entryValidCandles:valid,rr:side==="BUY"?2:2,maxConsecutiveLosses:2,minStopLossDistancePct:0},signal};
}

for(const [side,type] of [["BUY","A"],["BUY","B"],["SELL","A"],["SELL","B"]])test(`spot simulator executes ${side} ${type} signal using 1m only`,()=>{
  const f=fixture({side,type,exit:"TARGET"}),r=runSpotBacktest(f.data,f.cfg);assert.equal(r.trades.length,1);assert.equal(r.trades[0].direction,side);assert.equal(r.trades[0].signalType,type);assert.equal(r.trades[0].outcome,"TARGET");assert.equal(r.trades[0].entryPrice,side==="BUY"?f.data.candles[14].h:f.data.candles[14].l);assert.equal(r.diagnostics.executionResolution,"1");
});
test("T0 cannot enter, T1 strict breakout does, and Entry Valid Candles expires pending",()=>{
 const f=fixture({breakout:false,valid:2}),sigIndex=14;f.data.candles[sigIndex+1].h=f.data.candles[sigIndex].h;f.data.candles[sigIndex+2].h=f.data.candles[sigIndex].h;const no=runSpotBacktest(f.data,f.cfg);assert.equal(no.summary.totalEntries,0);
 const g=fixture({valid:1});g.data.candles[15].h=g.data.candles[10].h;assert.equal(runSpotBacktest(g.data,g.cfg).summary.totalEntries,0);
});
test("BUY/SELL spot target and stop outcomes use signal range and RR",()=>{
 for(const side of ["BUY","SELL"]){const target=fixture({side,exit:"TARGET"}),tr=runSpotBacktest(target.data,target.cfg).trades[0];assert.equal(tr.outcome,"TARGET");assert.equal(tr.target,side==="BUY"?110:90);const stop=fixture({side,exit:"SL"}),sl=runSpotBacktest(stop.data,stop.cfg).trades[0];assert.equal(sl.outcome,"SL");assert.equal(sl.sl,side==="BUY"?98:102);}
});
test("same 1m breakout candle touching SL and target is conservatively SL",()=>{const f=fixture({ambiguous:true});const r=runSpotBacktest(f.data,f.cfg);assert.equal(r.trades[0].outcome,"SL");assert.equal(r.trades[0].ambiguousBreakoutCandle,true);});
test("open position exits EOD at 15:15 and has no overnight trade",()=>{const f=fixture({});const r=runSpotBacktest(f.data,f.cfg),t=r.trades[0];assert.equal(t.outcome,"EOD");assert.match(t.exitTimestamp,/15:15:00\.000\+05:30$/);assert.equal(ymdIST(t.entryEpoch),day);});
test("minimum stop distance supports decimal percent values and zero disables",()=>{const f=fixture();const px=(f.data.candles[14].h-f.data.candles[14].l)/f.data.candles[14].h*100;assert.equal(normalizeSpot({...f.cfg,minStopLossDistancePct:.05}).minStopLossDistancePct,.05);assert.equal(runSpotBacktest(f.data,{...f.cfg,minStopLossDistancePct:px+.001}).summary.pendingSetups,0);assert.equal(runSpotBacktest(f.data,{...f.cfg,minStopLossDistancePct:0}).summary.pendingSetups,1);});
test("warmup never creates a trade and requested dates bound all trading",()=>{
 const f=fixture({breakout:false}),before=f.data.candles[3];Object.assign(before,{o:99,h:102,l:98,c:101});f.data.emaCache.get(20)[3]=100;f.data.emaCache.get(20)[2]=99;
 Object.assign(f.data.candles[4],{h:105});assert.equal(runSpotBacktest(f.data,f.cfg).summary.totalEntries,0);
 const after={t:sessionDateEpoch("2026-06-02","09:15"),o:99,h:102,l:98,c:101,v:1};f.data.candles.push(after);f.data.emaCache.get(20).push(100);assert.equal(runSpotBacktest(f.data,f.cfg).trades.some(t=>t.date>day),false);
});
test("pending signal is cancelled at the 15:15 boundary",()=>{const f=fixture({breakout:false,valid:3}),sc=f.data.candles[4+358];Object.assign(sc,{o:99,h:102,l:98,c:101});f.data.emaCache.get(20)[4+358]=100;f.data.emaCache.get(20)[4+357]=99;f.data.candles.push({t:sessionDateEpoch(day,"15:15"),o:100,h:110,l:99,c:105});assert.equal(runSpotBacktest(f.data,f.cfg).summary.totalEntries,0);});
test("daily loss guard stops after consecutive SL; TARGET resets the streak",()=>{
 const f=fixture({exit:"SL"}),data=f.data,ema=data.emaCache.get(20);
 for(const [row,outcome]of [[20,"TARGET"],[30,"SL"],[40,"SL"]]){Object.assign(data.candles[4+row],{o:99,h:102,l:98,c:101});ema[4+row]=100;ema[4+row-1]=99;Object.assign(data.candles[4+row+1],{o:100,h:104,l:100,c:103});Object.assign(data.candles[4+row+2],outcome==="SL"?{o:100,h:101,l:97,c:98}:{o:100,h:110,l:100,c:109});}
 const r=runSpotBacktest(data,{...f.cfg,maxConsecutiveLosses:2});assert.deepEqual(r.trades.map(t=>t.outcome),["SL","TARGET","SL","SL"]);assert.equal(r.summary.maximumConsecutiveLosses,2);
});
test("summary expectancy and backtest/optimiser use identical simulator",async()=>{
 const f=fixture({exit:"TARGET"}),direct=runSpotBacktest(f.data,f.cfg),cfg={...f.cfg,mode:"FAST",emaMin:20,emaMax:20,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:2,validMax:2,rrMin:2,rrMax:2,rrStep:1,lossMin:2,lossMax:2,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1};assert.equal(direct.summary.expectancyR,2);
 const result=await optimiseSpot("mock",cfg,{data:f.data,fastLimit:20});assert.equal(result.status,"complete");assert.equal(result.evaluated,1);assert.equal(result.bestResult.expectancyR,direct.summary.expectancyR);assert.deepEqual(result.bestResult.summary,direct.summary);
});
test("spot optimizer dimensions exclude resolution and expiry and exhaustive count is exact",()=>{const f=fixture(),cfg={...f.cfg,mode:"EXHAUSTIVE",emaMin:2,emaMax:3,emaStep:1,slopeMin:1,slopeMax:2,slopeStep:1,validMin:1,validMax:2,rrMin:1,rrMax:2,rrStep:1,lossMin:1,lossMax:2,stopDistanceMin:0,stopDistanceMax:.1,stopDistanceStep:.1};const p=spotSearchPlan(cfg);assert.equal(p.requested,64);});
test("spot optimiser exhaustive completion, FAST non-exhaustive determinism, and cancellation semantics",async()=>{
 const f=fixture(),one={...f.cfg,mode:"EXHAUSTIVE",emaMin:20,emaMax:20,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:2,validMax:2,rrMin:2,rrMax:2,rrStep:1,lossMin:2,lossMax:2,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1};
 const exhaustive=await optimiseSpot("mock",one,{data:f.data});assert.equal(exhaustive.status,"complete");assert.equal(exhaustive.evaluated,1);assert.equal(exhaustive.exhaustive,true);
 const many={...one,mode:"FAST",emaMin:2,emaMax:6,emaStep:1,slopeMin:1,slopeMax:5,slopeStep:1,validMin:1,validMax:5,rrMin:1,rrMax:5,rrStep:1,lossMin:1,lossMax:5,stopDistanceMin:0,stopDistanceMax:.4,stopDistanceStep:.1};const a=await optimiseSpot("mock",many,{data:f.data,fastLimit:40}),b=await optimiseSpot("mock",many,{data:f.data,fastLimit:40});assert.equal(a.status,"complete");assert.ok(a.evaluated>0&&a.evaluated<spotSearchPlan(many).requested);assert.deepEqual(a.bestResult,b.bestResult);assert.equal(a.exhaustive,false);
 const controller=new AbortController();controller.abort();const cancelled=await optimiseSpot("mock",one,{data:f.data,signal:controller.signal});assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.evaluated,0);assert.notEqual(cancelled.status,"complete");
});
test("spot optimiser tie breakers are deterministic by resolved trades, win rate, then parameters",()=>{const base={expectancyR:1,resolvedTrades:4,winRatePct:50,emaLength:20,slopeLookback:2,entryValidCandles:2,rr:2,minStopLossDistancePct:.1,maxConsecutiveLosses:3};assert.ok(compareSpot({...base,resolvedTrades:5},base)<0);assert.ok(compareSpot({...base,winRatePct:60},base)<0);assert.ok(compareSpot({...base,emaLength:10},base)<0);});
test("spot data preparation issues a single 1m request and zero options/5s requests",async()=>{
 let calls=[];const store={history:async(...args)=>{calls.push(args);return []}};const cfg={symbol:"NIFTY",startDate:day,endDate:day,emaLength:2,slopeLookback:1};await assert.rejects(prepareSpotData("mock",cfg,{store}),/Insufficient 1-minute spot warm-up/);assert.equal(calls.length,1);assert.equal(calls[0][1],"1");assert.equal(calls[0][0],"NSE:NIFTY50-INDEX");
});

const optConfig=f=>({...f.cfg,mode:"EXHAUSTIVE",emaMin:20,emaMax:20,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:2,validMax:2,rrMin:2,rrMax:2,rrStep:1,lossMin:2,lossMax:2,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1});
test("15:14 breakout remains eligible and an unresolved fill exits at 15:15",()=>{
 const f=fixture({breakout:false}),i=4+358;Object.assign(f.data.candles[i],{o:99,h:102,l:98,c:101});f.data.emaCache.get(20)[i-1]=99;
 Object.assign(f.data.candles[i+1],{o:101,h:104,l:100,c:103});const r=runSpotBacktest(f.data,f.cfg);assert.equal(r.trades.length,1);assert.equal(r.trades[0].outcome,"EOD");assert.match(r.trades[0].exitTimestamp,/15:15:/);
});
test("same-candle ambiguity after entry is SL for both directions",()=>{
 for(const side of ["BUY","SELL"]){const f=fixture({side});Object.assign(f.data.candles[16],{o:100,h:120,l:80,c:100});const r=runSpotBacktest(f.data,f.cfg);assert.equal(r.trades[0].outcome,"SL");assert.equal(r.summary.expectancyR,-1);assert.equal(r.summary.slHits,1);}
});
test("T2 can break out, but T3 cannot execute an expired setup",()=>{
 for(const offset of [2,3]){const f=fixture({breakout:false});Object.assign(f.data.candles[14+offset],{o:100,h:104,l:100,c:103});assert.equal(runSpotBacktest(f.data,f.cfg).summary.totalEntries,offset===2?1:0);}
});
test("decimal stop-distance threshold applies to both formulas at the boundary",()=>{
 for(const side of ["BUY","SELL"]){const f=fixture({side});for(const c of f.data.candles)for(const k of ["o","h","l","c"])c[k]+=10000;for(let i=0;i<f.data.emaCache.get(20).length;i++)f.data.emaCache.get(20)[i]+=10000;
 const sc=f.data.candles[14],threshold=(sc.h-sc.l)/(side==="BUY"?sc.h:sc.l)*100;assert.ok(threshold<1);assert.equal(runSpotBacktest(f.data,{...f.cfg,minStopLossDistancePct:threshold}).summary.totalEntries,1);assert.equal(runSpotBacktest(f.data,{...f.cfg,minStopLossDistancePct:.05}).summary.totalEntries,0);}
});
test("backtest cancellation works during local evaluation and before fetching",async()=>{
 const f=fixture(),controller=new AbortController();const promise=backtestSpot("mock",f.cfg,{data:f.data,signal:controller.signal,onProgress:e=>{if(e.stage==="running_backtest")controller.abort();}});await assert.rejects(promise,/cancelled/);
 let calls=0;await assert.rejects(backtestSpot("mock",f.cfg,{signal:controller.signal,store:{history:async()=>{calls++;return [];}}}),/cancelled/);assert.equal(calls,0);
});
test("failed preparation blocks finalisation with zero evaluated candidates",async()=>{
 const f=fixture(),states=[];const r=await optimiseSpot("mock",optConfig(f),{store:{history:async()=>{throw new Error("fixture unavailable");}},onProgress:s=>states.push(structuredClone(s))});assert.equal(r.status,"failed");assert.equal(r.evaluated,0);assert.equal(r.progress.finalising_best_result.status,"blocked");assert.equal(r.bestResult,null);assert.ok(states.every(s=>s.preparationProgress?.stage!=="finalising_best_result"));
});
test("EXHAUSTIVE reports exact candidate progress and cancellation keeps partial rankings",async()=>{
 const f=fixture({exit:"TARGET"}),cfg={...optConfig(f),rrMax:4},states=[];
 const r=await optimiseSpot("mock",cfg,{data:f.data,onProgress:s=>states.push(structuredClone(s))});assert.equal(r.evaluated,3);assert.equal(r.requested,3);assert.equal(r.exhaustive,true);assert.deepEqual(r.results.map(x=>x.rr),[4,3,2]);assert.ok(states.some(s=>s.evaluationProgress?.completed===1&&s.evaluationProgress?.total===3));
 const controller=new AbortController();const partial=await optimiseSpot("mock",cfg,{data:f.data,signal:controller.signal,onProgress:s=>{if(s.evaluated===1)controller.abort();}});assert.equal(partial.status,"cancelled");assert.equal(partial.evaluated,1);assert.equal(partial.exhaustive,false);assert.equal(partial.results.length,1);
});
test("FAST coarse search refines deterministically without an invented denominator",async()=>{
 const f=fixture(),cfg={...optConfig(f),mode:"FAST",emaMin:2,emaMax:10},states=[];
 const r=await optimiseSpot("mock",cfg,{data:f.data,onCandidate:()=>{},onProgress:s=>states.push(structuredClone(s))});assert.ok(r.evaluated>4);assert.equal(r.exhaustive,false);
 const plan=spotSearchPlan(cfg),g=spotCandidates(plan);let next=g.next(),stages=[];while(!next.done){stages.push(next.value.stage);next=g.next({eligible:true,expectancyR:1,resolvedTrades:1,winRatePct:100,...next.value.parameters});}assert.ok(stages.some(s=>s.includes("Refinement")));
});
test("independent backtest and optimiser preparations preserve full trade parity with a wider warmup",async()=>{
 const f=fixture({exit:"TARGET"});f.cfg.emaLength=2;
 const candles=[];for(let d=20;d<=29;d++){const date=`2026-05-${d}`;for(let i=0;i<375;i++)candles.push({t:sessionDateEpoch(date,"09:15")+i*60,o:100,h:101,l:99,c:100+(i%7)*.01,v:0});}candles.push(...f.data.candles.filter(c=>c.t>=start));
 const calls=[],store={history:async(symbol,res,from,to)=>{calls.push({res,from,to});return candles.filter(c=>ymdIST(c.t)>=from&&ymdIST(c.t)<=to);}};
 const direct=await backtestSpot("mock",f.cfg,{store}),candidates=[];
 const opt=await optimiseSpot("mock",{...optConfig(f),emaMin:2,emaMax:400,emaStep:398},{store,onCandidate:r=>candidates.push(r)});assert.equal(opt.status,"complete",opt.reason);assert.equal(calls.length,2);assert.ok(calls[1].from<calls[0].from);assert.deepEqual(candidates[0].trades,direct.trades);assert.deepEqual(candidates[0].summary,direct.summary);assert.ok(direct.trades.length>0);assert.ok(calls.every(c=>c.res==="1"));
});
test("daily guard blocks subsequent setups and resets on the next trading day",()=>{
 const f=fixture({exit:"SL"}),data=f.data,ema=data.emaCache.get(20);const nextDay="2026-06-02";
 for(const row of [20,30]){Object.assign(data.candles[4+row],{o:99,h:102,l:98,c:101});ema[4+row-1]=99;Object.assign(data.candles[4+row+1],{o:100,h:104,l:100,c:103});}
 const original=data.candles.slice(4).map(c=>({...c,t:c.t+86400}));data.candles.push(...original);ema.push(...ema.slice(4));const r=runSpotBacktest(data,{...f.cfg,endDate:nextDay,maxConsecutiveLosses:1});assert.deepEqual(r.trades.map(t=>t.outcome),["SL","SL"]);assert.deepEqual(r.trades.map(t=>t.date),[day,nextDay]);assert.equal(r.summary.maximumConsecutiveLosses,1);
});
test("invalid ranges and zero steps fail before candidate evaluation",()=>{
 const f=fixture();for(const patch of [{stopDistanceStep:0},{rrStep:0},{emaStep:.5},{validMin:2.5}])assert.throws(()=>normalizeSpot({...optConfig(f),...patch},true));
});

test("fractional RR values and optimisation RR steps are accepted",()=>{
 const f=fixture();assert.equal(normalizeSpot({...f.cfg,rr:.5}).rr,.5);const cfg=normalizeSpot({...optConfig(f),rrMin:.5,rrMax:2,rrStep:.5},true);assert.equal(spotSearchPlan(cfg).requested,4);
});
