import test from "node:test";
import assert from "node:assert/strict";
import {simulate,breakout,findPremium,resultSummary,normalize} from "../src/engine.js";
import {candidates,buildDataset} from "../src/market.js";
import {inSession,sessionDateEpoch} from "../src/time.js";
import {fixture,cfg,start,bar,day} from "./fixtures.js";
const run=(f,c={})=>simulate(f.data,{...cfg,...c});
test("signal candle cannot execute; option entry/exit never use a pre-event open",async()=>{
 const f=fixture();f.data.monitor[0]=bar(start,104,200,1,104);
 const r=await run(f),t=r.trades[0];assert.equal(r.trades.length,1);
 assert.equal(t.breakoutConfirmedTime,new Date((start+65)*1000).toISOString());
 assert.equal(t.entryTime,new Date((start+120)*1000).toISOString());assert.equal(t.exitTime,new Date((start+180)*1000).toISOString());
 assert.equal(t.optionEntryPremium,10);assert.equal(t.optionExitPremium,12);assert.equal(t.grossPnl,100);assert.equal(t.netPnl,100-t.totalCharges);assert.equal(t.capitalAfter,100000+t.netPnl);
 assert.equal(t.spotEntry,104);assert.equal(t.positionSide,"LONG");assert.equal(t.optionPriceResolution,"1");assert.match(t.fillRule,/Never use/);
});
test("backtest progress reports actual ATM contract and validated premium history units without changing trades",async()=>{
 const f=fixture(),events=[],withProgress=await simulate(f.data,cfg,{onPreparationProgress:event=>events.push(event)}),withoutProgress=await run(fixture());
 assert.deepEqual(withProgress.trades,withoutProgress.trades);assert.equal(withProgress.summary.totalReturnPct,withoutProgress.summary.totalReturnPct);
 assert.ok(events.some(x=>x.stage==="option_contracts"&&x.unit==="contracts"&&x.completed===1&&x.total===null&&x.status==="resolving"));
 assert.ok(events.some(x=>x.stage==="option_premiums"&&x.unit==="histories"&&x.completed===0&&x.total===null&&x.status==="fetching"));
 assert.deepEqual(events.filter(x=>x.stage==="option_contracts"&&x.status==="complete").map(x=>[x.completed,x.total]),[[1,1]]);
 assert.deepEqual(events.filter(x=>x.stage==="option_premiums"&&x.status==="complete").map(x=>[x.completed,x.total]),[[1,1]]);
});
for(const sell of [false,true])test(`strict ${sell?"SELL <":"BUY >"} breakout, equality never triggers`,()=>{
 const f=fixture({sell,target:false});
 for(const m of f.data.monitor){if(m.t>=start+60&&m.t<start+240)Object.assign(m,sell?bar(m.t,100,102,97,100):bar(m.t,100,103,98,100));}
 const candidate=candidates(f.data,cfg)[0];assert.equal(breakout(f.data,candidate,cfg).trigger,null);
 const m=f.data.monitor[20];if(sell)m.l=96.99;else m.h=103.01;f.data.breakouts.clear();assert.equal(breakout(f.data,candidate,cfg).trigger.t,m.t+5);
});
test("pending validity is T1..TN and expires, ignoring new/opposite pending signals",async()=>{
 const f=fixture({target:false});
 // Every monitored bar through T2 equals but does not cross BUY level.
 for(const m of f.data.monitor)if(m.t>=start+60&&m.t<start+180)Object.assign(m,bar(m.t,100,103,98,100));
 f.data.strategy.push(bar(start+60,104,105,96,97)); // opposite setup while pending
 const result=await run(f,{entryValidCandles:2});assert.equal(result.trades.length,0);
 const candidate=candidates(f.data,{...cfg,entryValidCandles:2})[0];f.data.breakouts.clear();
 assert.equal(breakout(f.data,candidate,{...cfg,entryValidCandles:2}).trigger,null);
 f.data.breakouts.clear();assert.equal(breakout(f.data,candidate,{...cfg,entryValidCandles:3}).trigger.t,start+180);
});
test("ignore signals while position open; do not replay earlier setups after exit",async()=>{
 const f=fixture();f.data.strategy.push(bar(start+60,104,105,96,97),bar(start+120,104,105,96,97));
 const r=await run(f);assert.equal(r.trades.length,1);assert.equal(r.trades[0].direction,"BUY");
});
test("SELL buys PE and also earns (exit-entry)*quantity",async()=>{
 const r=await run(fixture({sell:true}));assert.equal(r.trades.length,1);const t=r.trades[0];assert.equal(t.optionType,"PE");assert.equal(t.direction,"SELL");assert.equal(t.grossPnl,100);assert.equal(t.underlyingSL,102);assert.equal(t.underlyingTarget,92);
});
test("configured lots multiply verified historical lot size for quantity, P&L and charges",async()=>{
 const one=await run(fixture({lotSize:50}));const two=await run(fixture({lotSize:50}),{lots:2});
 assert.equal(one.trades[0].lots,1);assert.equal(one.trades[0].quantity,50);assert.equal(one.trades[0].grossPnl,100);
 assert.equal(two.trades[0].lots,2);assert.equal(two.trades[0].quantity,100);assert.equal(two.trades[0].grossPnl,200);
 assert.equal(two.trades[0].stt,one.trades[0].stt*2);
 assert.equal(two.trades[0].underlying,"NIFTY");assert.equal(two.trades[0].tradeDate,day);
});
test("no historical lot-size fallback; missing required metadata stops the backtest",async()=>{
 await assert.rejects(run(fixture({lotSize:null}),{fallbackLotSize:999}),/Historical lot size unavailable.*no current lot-size fallback/);
});
test("missing ATM contract or required option premium after a confirmed breakout is incomplete market data",async()=>{
 const missingContract=fixture().data;missingContract.contractsByExpiry.set("2026-09-22",[]);
 await assert.rejects(simulate(missingContract,cfg),error=>error.incompleteData===true&&error.pipelineCounters.entriesRequiringOptions===1&&/actual ATM CE weekly contract unavailable/.test(error.message));
 const missingPremium=fixture().data;missingPremium.getOptions=async()=>[];
 await assert.rejects(simulate(missingPremium,cfg),error=>error.incompleteData===true&&error.pipelineCounters.optionContractsResolved===1&&error.pipelineCounters.optionPremiumHistoriesLoaded===1&&/option premium data unavailable/.test(error.message));
});
test("09:15 start, weekdays only",async()=>{
 assert.equal(inSession(start-5),false);assert.equal(inSession(start),true);assert.equal(inSession(sessionDateEpoch("2026-09-26")),false);assert.equal(inSession(sessionDateEpoch("2026-09-27")),false);
 const f=fixture();f.data.strategy[1]=bar(start-60,99,103,98,102);
 const r=await run(f);assert.ok(r.trades.every(t=>Date.parse(t.signalTime)>=start*1000));
 const delta=sessionDateEpoch("2026-09-26")-start;
 const weekend=buildDataset(f.data.strategy.map(c=>({...c,t:c.t+delta})),[],{classified:[],contractsByExpiry:new Map()});
 assert.equal((await simulate(weekend,{...cfg,startDate:"2026-09-26",endDate:"2026-09-27"})).trades.length,0);
});
test("15:15 forced exit uses exact option open and cannot roll overnight",async()=>{
 const f=fixture({target:false}),r=await run(f);assert.equal(r.trades[0].exitReason,"15:15");assert.equal(r.trades[0].exitTime,new Date((start+21600)*1000).toISOString());
 f.oc.pop();await assert.rejects(run(f),/cannot close without fabricating/);
});
test("pending expires at 15:15 without execution",async()=>{
 const f=fixture({target:false});f.data.strategy=[bar(start-120,100),bar(start-60,100),bar(start+21540,99,103,98,102)];
 assert.equal((await run(f)).trades.length,0);
});
test("same 5S bar SL/target ambiguity excluded and recorded, session blocked",async()=>{
 const f=fixture();Object.assign(f.data.monitor[25],bar(start+125,104,110,97,104));
 const r=await run(f);assert.equal(r.trades.length,0);assert.equal(r.skipped[0].reason,"AMBIGUOUS_SL_TARGET_SAME_BAR");assert.equal(r.summary.ambiguousCount,1);assert.match(r.skipped[0].handling,/DAY_BLOCKED/);
});
test("monitoring begins at actual option entry, not in pre-fill breakout bar",async()=>{
 const f=fixture();Object.assign(f.data.monitor[12],bar(start+60,102,110,90,104));
 const r=await run(f);assert.equal(r.trades.length,1);assert.equal(r.trades[0].exitReason,"TARGET");
});
test("premium selection obeys timestamp, deadline, and never fabricates prices",()=>{
 const rows=[bar(100,10),bar(160,12)];assert.equal(findPremium(rows,105,159),null);assert.deepEqual(findPremium(rows,105,160),{price:12,t:160});assert.deepEqual(findPremium(rows,160,160),{price:12,t:160});assert.equal(findPremium([],105,999),null);
});
test("5S option mode is explicit and independent from strategy resolution",async()=>{
 const f=fixture();f.data.getOptions=async()=>f.data.monitor.map(c=>({...c,o:10,h:10,l:10,c:10,v:1}));const r=await run(f,{optionResolution:"5S"});assert.equal(r.trades[0].entryTime,new Date((start+65)*1000).toISOString());assert.equal(r.trades[0].optionPriceResolution,"5S");assert.equal(r.config.resolution,"1");
});
test("consecutive loss guard stops new entries and resets next day",async()=>{
 const f=fixture();f.oc.forEach(c=>{c.o=10;});
 f.data.strategy.push(bar(start+240,99,103,98,102));
 Object.assign(f.data.monitor[60],bar(start+300,104));Object.assign(f.data.monitor[61],bar(start+305,104,110,103,109));
 const one=await run(f,{maxConsecutiveLosses:1}),two=await run(f,{maxConsecutiveLosses:2});assert.equal(one.trades.length,1);assert.equal(two.trades.length,2);
 const shift=86400,more=fixture();more.oc.forEach(c=>{c.o=10});
 const secondRows=more.data.monitor.map(c=>({...c,t:c.t+shift}));f.data.byDay.set("2026-09-22",secondRows);
 f.data.strategy.push(...more.data.strategy.filter(c=>c.t>=start).map(c=>({...c,t:c.t+shift})));
 f.data.signals.clear();f.data.emas.clear();f.data.getOptions=async(c,d)=>d===day?f.oc:more.oc.map(c=>({...c,t:c.t+shift}));
 const r=await run(f,{maxConsecutiveLosses:1,endDate:"2026-09-22"});assert.equal(r.trades.length,2);
});
test("summary is derived by gross/net signs independently and includes streaks/drawdown",()=>{
 const mk=(gross,net,capital)=>({grossPnl:gross,grossProfit:Math.max(0,gross),grossLoss:Math.min(0,gross),netPnl:net,netProfit:Math.max(0,net),netLoss:Math.min(0,net),capitalAfter:capital,totalCharges:gross-net,brokerage:10});
 const s=resultSummary([mk(5,-5,95),mk(20,10,105),mk(-10,-20,85),mk(-5,-15,70)],100);
 assert.equal(s.grossProfit,25);assert.equal(s.grossLoss,-15);assert.equal(s.netProfit,10);assert.equal(s.netLoss,-40);assert.equal(s.profitFactor,.25);assert.equal(s.averageLoss,-40/3);assert.equal(s.largestLoss,-20);assert.equal(s.maxConsecutiveLosses,2);assert.equal(s.totalBrokerage,40);assert.ok(Math.abs(s.maxDrawdownPct-100/3)<1e-10);assert.equal(s.finalCapital,70);
});
test("configuration rejects NaN, zero steps, invalid ranges/dates/resolution and strips extra fields",()=>{
 for(const x of [{lots:0},{rr:NaN},{startDate:"2026-02-30"},{endDate:"2099-01-01"}])assert.throws(()=>normalize({...cfg,...x}));
 const fixed=normalize({...cfg,resolution:"15",expiryType:"MONTHLY"});assert.equal(fixed.resolution,"1");assert.equal(fixed.expiryType,"WEEKLY");
 const c=normalize({...cfg,access_token:"do-not-echo",fallbackLotSize:999});assert.equal(c.access_token,undefined);assert.equal(c.fallbackLotSize,undefined);
});
test("option fill skips empty non-traded candles without inventing a price",()=>{
 const rows=[bar(100,10,10,10,10,0),bar(160,12)];assert.deepEqual(findPremium(rows,100,160),{price:12,t:160});
});

// Strategy candles and execution candles deliberately tell different stories.
// A huge T0 range cannot execute; exact later 5S touches determine SL/target.
for(const resolution of ["1"])for(const side of ["BUY","SELL"])for(const reason of ["SL","TARGET"]){
 test(`${resolution}m ${side}: T0 ignored, strict 5S breakout, underlying 5S ${reason}`,async()=>{
  const sell=side==="SELL",f=fixture({sell,target:false}),seconds=Number(resolution)*60;
  f.data.strategy=[bar(start-seconds*2,100),bar(start-seconds,100),sell?bar(start,101,102,97,98):bar(start,99,103,98,102)];
  for(const m of f.data.monitor){
   if(m.t<start+seconds)Object.assign(m,bar(m.t,100,1000,1,100));
   else Object.assign(m,bar(m.t,sell?96:104));
  }
  const offset=seconds/5;
  for(let n=0;n<2;n++)Object.assign(f.data.monitor[offset+n],sell?bar(start+seconds+n*5,100,102,97,100):bar(start+seconds+n*5,100,103,98,100));
  Object.assign(f.data.monitor[offset+2],sell?bar(start+seconds+10,98,99,96,96):bar(start+seconds+10,102,104,101,104));
  const entry=start+seconds+60,event=entry+5;
  Object.assign(f.data.monitor[(event-start)/5],sell?(reason==="SL"?bar(event,96,102,95,96):bar(event,96,96,92,94)):(reason==="SL"?bar(event,104,104,98,100):bar(event,104,108,103,106)));
  const result=await run(f,{resolution});assert.equal(result.trades.length,1);
  const trade=result.trades[0];assert.equal(trade.direction,side);assert.equal(trade.optionType,sell?"PE":"CE");assert.equal(trade.underlyingResolution,"5S");
  assert.equal(trade.breakoutConfirmedTime,new Date((start+seconds+15)*1000).toISOString());assert.equal(trade.entryTime,new Date(entry*1000).toISOString());
  assert.equal(trade.exitReason,reason);assert.equal(trade.exitEventTime,new Date((event+5)*1000).toISOString());assert.equal(trade.exitTime,new Date((entry+60)*1000).toISOString());
});
}
test("minimum stop-loss distance filters signal setups using spot candle percentages",async()=>{
 const buy=fixture(),buyResult=await run(buy,{minStopLossDistancePct:4.9});assert.equal(buyResult.trades.length,0);
 const buyPass=await run(fixture(),{minStopLossDistancePct:4.8});assert.equal(buyPass.trades.length,1);
 const sell=fixture({sell:true}),sellResult=await run(sell,{minStopLossDistancePct:5.2});assert.equal(sellResult.trades.length,0);
 const sellPass=await run(fixture({sell:true}),{minStopLossDistancePct:5.1});assert.equal(sellPass.trades.length,1);
});
test("option OHLC extremes cannot trigger underlying SL or target",async()=>{
 const f=fixture({target:false});f.oc.forEach(c=>{c.h=999999;c.l=.01;});
 const result=await run(f);assert.equal(result.trades[0].exitReason,"15:15");
});
