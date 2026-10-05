import {emaSeries,signalAt} from "./strategy.js";
import {marketStore,SYMBOLS} from "./market.js";
import {warmupStart} from "./market.js";
import {ymdIST,hmIST,weekdayIST,sessionDateEpoch} from "./time.js";
import {validDate} from "./fyers.js";

export function normalizeSpot(input,optimization=false){
  const c={symbol:String(input.symbol??"NIFTY"),startDate:String(input.startDate??""),endDate:String(input.endDate??""),resolution:"1"};
  if(!SYMBOLS[c.symbol])throw new Error("Symbol must be NIFTY or BANKNIFTY");
  if(!validDate(c.startDate)||!validDate(c.endDate)||c.startDate>c.endDate)throw new Error("Invalid requested date range");
  if(c.endDate>=ymdIST(Date.now()/1000))throw new Error("Use completed historical dates ending before today");
  c.minStopLossDistancePct=Number(input.minStopLossDistancePct??0);
  const keys=optimization?["emaMin","emaMax","emaStep","slopeMin","slopeMax","slopeStep","validMin","validMax","rrMin","rrMax","rrStep","lossMin","lossMax","stopDistanceMin","stopDistanceMax","stopDistanceStep"]:["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses"];
  if(!Number.isFinite(c.minStopLossDistancePct)||c.minStopLossDistancePct<0)throw new Error("Minimum Stop-Loss Distance % must be finite and non-negative");
  for(const key of keys){const min=key.startsWith("stopDistance")||key.startsWith("rr")?0:1;const fallback=key==="stopDistanceStep"?.1:key.startsWith("stopDistance")?0:NaN;const n=Number(input[key]??fallback);if(!Number.isFinite(n)||n<min||(key.startsWith("rr")&&n===0))throw new Error(`${key} must be a finite ${min===0?"non-negative":"positive"} number`);c[key]=n;if(!key.startsWith("rr")&&!key.startsWith("stopDistance")&&!Number.isSafeInteger(n))throw new Error(`${key} must be an integer`);}
  if(optimization){
    if(c.stopDistanceStep<=0)throw new Error("Stop-distance step must be positive");
    c.mode=String(input.mode??"FAST");if(!["FAST","EXHAUSTIVE"].includes(c.mode))throw new Error("Optimisation mode must be FAST or EXHAUSTIVE");
    if(c.emaMax<c.emaMin||c.slopeMax<c.slopeMin||c.validMax<c.validMin||c.rrMax<c.rrMin||c.lossMax<c.lossMin||c.stopDistanceMax<c.stopDistanceMin)throw new Error("Optimisation ranges must have max >= min");
    c.minStopLossDistancePct=c.stopDistanceMin;
  }
  return c;
}
const istTime=t=>new Date((t+19800)*1000).toISOString().replace("Z","+05:30");
export const spotRequestCounters=()=>({oneMinuteRequests:0,networkHistoryRequests:0,cacheHits:0,inFlightDeduplications:0,rateLimitResponses:0,retries:0,execution5sRequests:0,expiryRequests:0,optionHistoryRequests:0});
export function spotWarmupStart(startDate,emaLength,slopeLookback){return warmupStart(startDate,emaLength,slopeLookback,"1");}
export async function prepareSpotData(token,cfg,{store=marketStore(token),signal,onProgress=()=>{},check=()=>{},diagnosticCounters=spotRequestCounters()}={}){
  const maxEma=cfg.emaMax??cfg.emaLength,maxSlope=cfg.slopeMax??cfg.slopeLookback,warm=spotWarmupStart(cfg.startDate,maxEma,maxSlope),symbol=SYMBOLS[cfg.symbol];
  check();onProgress({stage:"fetching_spot",status:"fetching",activity:`Fetching 1-minute ${cfg.symbol} spot candles — ${warm} → ${cfg.endDate}`});
  let candles;try{candles=await store.history(symbol,"1",warm,cfg.endDate,{signal,diagnosticCounters,purpose:"spot-only strategy candles 1m",onPreparationProgress:event=>onProgress({...event,stage:"fetching_spot"})});}catch(error){onProgress({stage:"fetching_spot",status:"failed",activity:`1-minute spot data failed: ${error.message}`});throw error;}
  check();onProgress({stage:"fetching_spot",status:"complete",activity:"1-minute spot history fetched"});
  onProgress({stage:"preparing_market_data",status:"processing",activity:"Validating reusable spot candles"});
  const sorted=candles.filter(c=>ymdIST(c.t)>=warm&&ymdIST(c.t)<=cfg.endDate).sort((a,b)=>a.t-b.t);
  const warmupCandles=sorted.filter(c=>ymdIST(c.t)<cfg.startDate);
  if(warmupCandles.length<maxEma+maxSlope)throw new Error(`Insufficient 1-minute spot warm-up before ${cfg.startDate}: received ${warmupCandles.length} candles; require at least ${maxEma+maxSlope}. No backtest was run.`);
  const sessions=new Map();for(const c of sorted){const day=ymdIST(c.t);if(day<cfg.startDate||day>cfg.endDate||weekdayIST(c.t)===0||weekdayIST(c.t)===6)continue;const hm=hmIST(c.t);if(hm<"09:15"||hm>"15:14")continue;if(!sessions.has(day))sessions.set(day,[]);sessions.get(day).push(c);}
  // A weekday with some candles must have the complete 09:15–15:14 session.
  // Empty dates are left as no-data/holiday sessions; no candles are synthesized.
  for(const [day,rows] of sessions){const set=new Set(rows.map(c=>c.t));for(let t=sessionDateEpoch(day,"09:15");t<sessionDateEpoch(day,"15:15");t+=60)if(!set.has(t))throw new Error(`Incomplete 1-minute SPOT history on ${day}; missing candle ${istTime(t)}. No backtest was run.`);}
  if(!sessions.size)throw new Error(`No 1-minute NIFTY/BANKNIFTY SPOT candles are available during the requested trading range ${cfg.startDate} → ${cfg.endDate}.`);
  onProgress({stage:"preparing_market_data",status:"complete",completed:sorted.length,total:sorted.length,unit:"candles",activity:`Prepared ${sorted.length} valid 1-minute spot candles`});
  return {symbol,candles:sorted,sessions,warmupStart:warm,historyRequests:diagnosticCounters,emaCache:new Map()};
}
function getEma(data,cfg){
  const length=cfg.emaLength,seed=spotWarmupStart(cfg.startDate,length,cfg.slopeLookback),key=`${length}:${seed}`;
  data.emaCache??=new Map();
  // Numeric keys are supported for explicit indicator fixtures only.
  if(data.emaCache.has(length))return data.emaCache.get(length);
  if(!data.emaCache.has(key)){
    const offset=data.candles.findIndex(c=>ymdIST(c.t)>=seed);
    const values=Array(Math.max(0,offset)).fill(null).concat(emaSeries(data.candles.slice(Math.max(0,offset)),length));
    if(data.emaCache.size>=32)data.emaCache.delete(data.emaCache.keys().next().value);
    data.emaCache.set(key,values);
  }
  return data.emaCache.get(key);
}
function* getSignals(data,cfg,active,ema,check,onProgress){
  data.signalCache??=new Map();const key=`${cfg.emaLength}:${cfg.slopeLookback}:${cfg.startDate}:${cfg.endDate}`;
  if(!data.signalCache.has(key)){const records=[];for(let n=0;n<active.length;n++){if(n%1000===0){yield;check();onProgress({stage:"finding_signals",status:"processing",completed:n,total:active.length,unit:"candles",activity:`Finding completed-candle EMA signals — ${n} / ${active.length}`});}const i=active[n],sig=signalAt(data.candles,ema,i,cfg.slopeLookback);if(sig){const c=data.candles[i],stopDistancePct=(c.h-c.l)/(sig.side==="BUY"?c.h:c.l)*100;records.push({i,c,sig,ema:ema[i],slope:sig.side==="BUY"?"UP":"DOWN",stopDistancePct});}}if(data.signalCache.size>=32)data.signalCache.delete(data.signalCache.keys().next().value);data.signalCache.set(key,records);}
  return data.signalCache.get(key);
}
function tradeOutcome(trade,candle,sl,target){
  const buy=trade.direction==="BUY",hitSL=buy?candle.l<=sl:candle.h>=sl,hitTarget=buy?candle.h>=target:candle.l<=target;
  if(hitSL)return {outcome:"SL",price:sl,time:candle.t+60,ambiguous:hitTarget};
  if(hitTarget)return {outcome:"TARGET",price:target,time:candle.t+60,ambiguous:false};
  return null;
}
function* spotSimulation(data,cfg,{check=()=>{},onProgress=()=>{}}={}){
  check();yield;
  const ema=getEma(data,cfg),stats={totalSignals:0,buyASignals:0,buyBSignals:0,sellASignals:0,sellBSignals:0,signalsPassingMinStopDistance:0,pendingSetups:0,breakouts:0,totalEntries:0,targetHits:0,slHits:0,eodExits:0},trades=[];
  data.activeCache??=new Map();const activeKey=`${cfg.startDate}:${cfg.endDate}`,active=data.activeCache.get(activeKey)??[];if(!data.activeCache.has(activeKey)){for(let i=0;i<data.candles.length;i++){const c=data.candles[i],day=ymdIST(c.t);if(day>=cfg.startDate&&day<=cfg.endDate&&weekdayIST(c.t)>0&&weekdayIST(c.t)<6&&hmIST(c.t)>="09:15"&&hmIST(c.t)<="15:14")active.push(i);}data.activeCache.set(activeKey,active);}
  onProgress({stage:"preparing_indicators",status:"complete",completed:data.candles.length,total:data.candles.length,unit:"candles",activity:`EMA ${cfg.emaLength} and slope ${cfg.slopeLookback} prepared`});
  const signalRecords=yield* getSignals(data,cfg,active,ema,check,onProgress);const signals=new Map(signalRecords.map(row=>[row.i,row]));
  onProgress({stage:"finding_signals",status:"complete",completed:active.length,total:active.length,unit:"candles",activity:`Found ${signalRecords.length} completed-candle signals`});
  for(const {sig,stopDistancePct} of signalRecords){stats.totalSignals++;const code=`${sig.side}_${sig.type}`;if(code==="BUY_A")stats.buyASignals++;else if(code==="BUY_B")stats.buyBSignals++;else if(code==="SELL_A")stats.sellASignals++;else stats.sellBSignals++;if(stopDistancePct>=cfg.minStopLossDistancePct)stats.signalsPassingMinStopDistance++;}
  let pending=null,position=null,lossesToday=0,maxLossStreak=0,lossStreak=0,lastDay=null,previousSession=null;
  const close=(trade,outcome,price,t)=>{trade.exitTimestamp=istTime(t);trade.exitPrice=price;trade.outcome=outcome;trade.holdingMinutes=Math.max(0,(t-trade.entryEpoch)/60);if(outcome==="TARGET"){stats.targetHits++;lossesToday=0;lossStreak=0;}else if(outcome==="SL"){stats.slHits++;lossesToday++;lossStreak++;maxLossStreak=Math.max(maxLossStreak,lossStreak);}else stats.eodExits++;trades.push(trade);position=null;};
  for(let cursor=0;cursor<active.length;cursor++){
    if(cursor%500===0){yield;check();onProgress({stage:"running_backtest",status:"processing",completed:cursor,total:active.length,unit:"candles",activity:`Running 1-minute spot backtest — candle ${cursor} / ${active.length}`});}
    const idx=active[cursor],c=data.candles[idx],day=ymdIST(c.t);
    if(day!==lastDay){if(previousSession&&previousSession!==day){pending=null;position=null;}lossesToday=0;lossStreak=0;lastDay=day;}
    if(position){const outcome=tradeOutcome(position,c,position.sl,position.target);if(outcome)close(position,outcome.outcome,outcome.price,outcome.time);else if(hmIST(c.t)==="15:14")close(position,"EOD",c.c,c.t+60);previousSession=day;continue;}
    if(pending){
      
      pending.validSeen++;
      const breakout=pending.signal.side==="BUY"?c.h>pending.candle.h:c.l<pending.candle.l;
      if(breakout){stats.breakouts++;stats.totalEntries++;const buy=pending.signal.side==="BUY",entry=buy?pending.candle.h:pending.candle.l,risk=pending.candle.h-pending.candle.l,sl=buy?pending.candle.l:pending.candle.h,target=buy?entry+risk*cfg.rr:entry-risk*cfg.rr;
        const trade={tradeNumber:stats.totalEntries,date:day,direction:pending.signal.side,signalType:pending.signal.type,signalTimestamp:istTime(pending.candle.t+60),signalOpen:pending.candle.o,signalHigh:pending.candle.h,signalLow:pending.candle.l,signalClose:pending.candle.c,ema:pending.ema,emaSlope:pending.slope,stopDistancePct:pending.stopDistancePct,entryTimestamp:istTime(c.t+60),entryPrice:entry,sl,target,rr:cfg.rr,entryEpoch:c.t+60,breakoutCandleTimestamp:istTime(c.t),ambiguousBreakoutCandle:false};
        const immediate=tradeOutcome(trade,c,sl,target);
        if(immediate){trade.ambiguousBreakoutCandle=immediate.ambiguous;close(trade,immediate.outcome,immediate.price,immediate.time);}
        else if(hmIST(c.t)==="15:14")close(trade,"EOD",c.c,c.t+60);
        else position=trade;
        pending=null;previousSession=day;continue;
      }
      if(pending.validSeen>=cfg.entryValidCandles)pending=null;
      previousSession=day;continue;
    }
    if(hmIST(c.t)==="15:14"){previousSession=day;continue;}
    if(lossesToday>=cfg.maxConsecutiveLosses){previousSession=day;continue;}
    const record=signals.get(idx);if(!record){previousSession=day;continue;}
    const {sig,stopDistancePct}=record;if(stopDistancePct<cfg.minStopLossDistancePct){previousSession=day;continue;}
    stats.pendingSetups++;pending={candle:c,signal:sig,ema:record.ema,slope:record.slope,stopDistancePct,validSeen:0};previousSession=day;
  }
  if(position){const last=data.candles[active.at(-1)];close(position,"EOD",last.c,last.t+60);}
  pending=null;
  const resolved=stats.targetHits+stats.slHits,winRate=resolved?stats.targetHits/resolved*100:0,lossRate=resolved?stats.slHits/resolved*100:0;
  const holding=trades.map(t=>t.holdingMinutes).sort((a,b)=>a-b),median=holding.length?(holding.length%2?holding[(holding.length-1)/2]:(holding[holding.length/2-1]+holding[holding.length/2])/2):0;
  const buyTrades=trades.filter(t=>t.direction==="BUY"),sellTrades=trades.filter(t=>t.direction==="SELL"),summary={...stats,buyTrades:buyTrades.length,buyTargetHits:buyTrades.filter(t=>t.outcome==="TARGET").length,buySLHits:buyTrades.filter(t=>t.outcome==="SL").length,buyWinRatePct:buyTrades.filter(t=>t.outcome==="TARGET").length/(buyTrades.filter(t=>t.outcome!=="EOD").length||1)*100,sellTrades:sellTrades.length,sellTargetHits:sellTrades.filter(t=>t.outcome==="TARGET").length,sellSLHits:sellTrades.filter(t=>t.outcome==="SL").length,sellWinRatePct:sellTrades.filter(t=>t.outcome==="TARGET").length/(sellTrades.filter(t=>t.outcome!=="EOD").length||1)*100,resolvedWinRatePct:winRate,targetHitRateAllEntriesPct:stats.totalEntries?stats.targetHits/stats.totalEntries*100:0,lossRatePct:lossRate,expectancyR:resolved?(stats.targetHits/resolved*cfg.rr-stats.slHits/resolved):0,maximumConsecutiveLosses:maxLossStreak,averageHoldingTimeMinutes:trades.length?holding.reduce((a,b)=>a+b,0)/trades.length:0,medianHoldingTimeMinutes:median};
  onProgress({stage:"running_backtest",status:"complete",completed:active.length,total:active.length,unit:"candles",activity:`Processed ${active.length} eligible 1-minute candles`});
  yield;check();
  onProgress({stage:"finalising_statistics",status:"processing",completed:0,total:null,unit:"statistics",activity:"Finalising spot trade statistics"});
  onProgress({stage:"finalising_statistics",status:"complete",completed:1,total:1,unit:"statistics",activity:"Spot trade statistics ready"});
  return {config:cfg,summary,trades,diagnostics:{eligibleCandles:active.length,emaWarmupStart:data.warmupStart,historyRequests:data.historyRequests,spotOnly:true,executionResolution:"1",dailyGuardEODBehavior:"EOD exit does not change the consecutive-SL count; only SL increments it and TARGET resets it."}};
}
export function runSpotBacktest(data,cfg,options={}){
  const simulation=spotSimulation(data,cfg,options);let next=simulation.next();while(!next.done)next=simulation.next();return next.value;
}
export async function runSpotBacktestAsync(data,cfg,options={}){
  const simulation=spotSimulation(data,cfg,options);let next=simulation.next();
  while(!next.done){await new Promise(resolve=>setImmediate(resolve));next=simulation.next();}return next.value;
}
export async function backtestSpot(token,input,options={}){
  const cfg=normalizeSpot(input,false),diagnosticCounters=options.diagnosticCounters??spotRequestCounters();
  const check=()=>{if(options.signal?.aborted)throw Object.assign(new Error("Spot backtest cancelled"),{code:"CANCELLED"});options.check?.();};
  check();const data=options.data??await prepareSpotData(token,cfg,{...options,check,diagnosticCounters});
  options.onProgress?.({stage:"preparing_indicators",status:"processing",activity:"Preparing EMA and completed-candle indicators"});
  return runSpotBacktestAsync(data,cfg,{...options,check});
}
