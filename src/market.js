import * as fyers from "./fyers.js";
import {historyRequestDiagnostics} from "./fyers.js";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {addDays,ymdIST,inSession} from "./time.js";
import {extractExpiryDates,extractContracts,extractActiveExpiries,extractActiveContracts,classifyExpiries,chooseExpiry} from "./contracts.js";
import {emaSeries,signalAt} from "./strategy.js";
export const SYMBOLS={NIFTY:"NSE:NIFTY50-INDEX",BANKNIFTY:"NSE:NIFTYBANK-INDEX"};
const stores=new Map();
export function createMarketStore(token,api=fyers){
  const requests=new Map();
  // Share successful work within a prepared snapshot. Do not pin transient/API
  // failures here: the process-wide FYERS scheduler owns retry and success cache.
  const once=(key,fn)=>{
    const cached=requests.get(key);if(cached&&cached.expiresAt>Date.now())return cached.promise;if(cached)requests.delete(key);
    const entry={expiresAt:Infinity,promise:null},pending=Promise.resolve().then(fn);entry.promise=pending;requests.set(key,entry);
    pending.then(()=>{if(requests.get(key)===entry)entry.expiresAt=Date.now()+86400000;},()=>{if(requests.get(key)===entry)requests.delete(key);});
    return pending;
  };
  const call=(kind,method,args)=>{
    const last=args.at(-1),hasOptions=last&&typeof last==="object"&&("signal"in last||"onState"in last||"purpose"in last),opts=hasOptions?last:{};
    const values=hasOptions?args.slice(0,-1):args,key=`${kind}:${JSON.stringify(values)}`;
    const invoke=()=>method(token,...values,opts);
    // Production FYERS calls must reach the one global scheduler so its logical,
    // cache and in-flight counters reflect every caller. Injected providers retain
    // snapshot-local promise reuse for deterministic tests/offline fixtures.
    return api===fyers?invoke():once(key,invoke);
  };
  return {
    requests,
    history:(...args)=>call("h",api.history,args),
    expiryDates:(...args)=>call("e",api.expiryDates,args),
    optionChain:typeof api.optionChain==="function"?(symbol,expiryEpoch,options={})=>{
      if(expiryEpoch&&typeof expiryEpoch==="object"){options=expiryEpoch;expiryEpoch=undefined;}
      return call("oc",api.optionChain,[symbol,expiryEpoch,options]);
    }:undefined,
    contracts:(...args)=>call("c",api.expiredSymbols,args),
    options:(...args)=>call("o",api.expiredHistory,args),
    activeOptions:typeof api.activeOptionHistory==="function"?(...args)=>call("ao",api.activeOptionHistory,args):undefined
  };
}
export function marketStore(token){
  const key=createHash("sha256").update(token).digest("hex");
  if(!stores.has(key)){stores.clear();stores.set(key,createMarketStore(token));}
  return stores.get(key);
}
export function clearMarketStores(){stores.clear();}
export function lowerBound(rows,t){let lo=0,hi=rows.length;while(lo<hi){const m=(lo+hi)>>>1;if(rows[m].t<t)lo=m+1;else hi=m;}return lo;}
export function buildDataset(strategy,monitor,extra={}){
  const byDay=new Map();
  for(const c of monitor){const day=ymdIST(c.t);if(!byDay.has(day))byDay.set(day,[]);byDay.get(day).push(c);}
  return {strategy,monitor,byDay,emas:new Map(),signals:new Map(),breakouts:new Map(),exits:new Map(),optionData:new Map(),
    expirySelections:new Map(),contractSelections:new Map(),cacheBytes:0,
    cacheStats:{emaCalculations:0,signalCalculations:0,breakoutScans:0,exitScans:0,contractSelections:0},...extra};
}
export function marketDataSummary(data,cfg){
  const selectedContracts=new Set([...data.contractSelections.values()].filter(Boolean).map(x=>x.symbol));
  const resolvedExpiryDates=new Set(data.applicableExpiryByDay?.values?.()??[]);
  return {backtestStart:cfg.startDate,backtestEnd:cfg.endDate,strategyResolution:cfg.resolution,
    strategyRangeStart:data.strategyRangeStart??null,strategyRangeEnd:cfg.endDate,executionRangeStart:cfg.startDate,executionRangeEnd:cfg.endDate,
    tradingDays:data.tradingDays??0,strategyCandles:data.strategy.length,executionCandles:data.monitor.length,
    // Report expiries resolved for the requested trading dates, not only
    // expiries touched by an executed entry. A valid zero-signal run can still
    // have its weekly expiry infrastructure verified and counted here.
    resolvedExpiries:resolvedExpiryDates.size,weeklyExpiryDatesDiscovered:data.weeklyExpiryDatesDiscovered??0,
    expiryDiagnostics:data.expiryDiagnostics??[],requiredOptionContracts:selectedContracts.size,uniqueOptionContracts:selectedContracts.size,
    optionContractSelectionEntries:data.contractSelections?.size??0,requiredOptionContractsMeaning:"unique selected contract symbols; not entry count or premium-history count",
    optionPremiumHistoriesLoaded:data.optionData.size,optionPremiumCandles:[...data.optionData.values()].reduce((n,rows)=>n+rows.length,0),historyRequests:historyRequestDiagnostics()};
}
export function warmupStart(startDate,emaLength,slopeLookback,resolution){
  // Request only enough prior calendar to cover the required completed bars,
  // with a two-day weekend boundary allowance. Missing holiday sessions are
  // detected by the later warm-up count; they are never synthesized.
  const bars=Math.max(0,emaLength+slopeLookback),sessions=Math.ceil(bars*Number(resolution)/375);
  return addDays(startDate,-Math.max(3,Math.ceil(sessions*7/5)+2));
}
export function expiryDiscoveryEnd(endDate,expiryType){
  // Discover expiries in the actual trading range first, then only enough
  // post-range calendar to cover the next actual contract: daily/weekly use an
  // 8-day holiday-safe window; monthly extends through the next calendar month.
  const weekly=addDays(endDate,8);
  if(expiryType!=="MONTHLY"&&expiryType!=="ALL")return weekly;
  const [year,month]=endDate.split("-").map(Number),nextMonth=new Date(Date.UTC(year,month+1,0));
  const monthEnd=nextMonth.toISOString().slice(0,10);
  return monthEnd>weekly?monthEnd:weekly;
}
export function remember(data,cache,key,value,bytes=192){
  if(data.cacheBytes+bytes>(data.cacheBudget??Infinity)){
    const error=new Error("Reusable calculation cache reached its memory budget; evaluation is incomplete. Increase OPTIMISATION_MAX_CACHE_BYTES for this range.");
    error.code="CACHE_BUDGET_EXCEEDED";throw error;
  }
  data.cacheBytes+=bytes;cache.set(key,value);return value;
}
export function emaFor(data,cfg){
  // A job fixes one seed date before evaluating any candidate. Apply Best carries
  // this data context into the detailed run: same first-close seed and recurrence.
  // Slope/RR/validity/expiry/loss-guard changes never create another EMA series.
  const warm=cfg.emaSeedDate??warmupStart(cfg.startDate,cfg.emaLength,cfg.slopeLookback,cfg.resolution);
  const key=`${cfg.resolution}:${cfg.emaLength}:${warm}`;
  if(!data.emas.has(key)){
    const first=data.strategy.findIndex(c=>ymdIST(c.t)>=warm);
    const values=first<0?[]:[...new Array(first).fill(null),...emaSeries(data.strategy.slice(first),cfg.emaLength)];
    remember(data,data.emas,key,values,values.length*8+128);data.cacheStats.emaCalculations++;
  }
  return {key,values:data.emas.get(key)};
}
const SIGNALS=[{side:"BUY",type:"A"},{side:"BUY",type:"B"},{side:"SELL",type:"A"},{side:"SELL",type:"B"}];
class SignalCandidates {
  constructor(data,ema,codes,lookback){Object.assign(this,{data,ema,codes,lookback});}
  get length(){return this.codes.length;}
  get 0(){return this.at(0);}
  at(n){
    if(n<0||n>=this.codes.length)return undefined;
    const code=this.codes[n],i=Math.floor(code/4),sc=this.data.strategy[i];
    return {i,sc,day:ymdIST(sc.t),sig:SIGNALS[code%4],ema:this.ema[i],emaPrevious:this.ema[i-this.lookback]};
  }
  *[Symbol.iterator](){for(let n=0;n<this.length;n++)yield this.at(n);}
}
export function candidates(data,cfg){
  const {key:emaKey,values:ema}=emaFor(data,cfg),key=`${emaKey}:${cfg.slopeLookback}:${cfg.startDate}:${cfg.endDate}`;
  if(!data.signals.has(key)){
    const codes=[];
    for(let i=cfg.emaLength-1+cfg.slopeLookback;i<data.strategy.length;i++){
      const sc=data.strategy[i],day=ymdIST(sc.t);
      if(day<cfg.startDate||day>cfg.endDate||!inSession(sc.t))continue;
      const sig=signalAt(data.strategy,ema,i,cfg.slopeLookback);
      if(sig)codes.push(i*4+(sig.side==="BUY"?0:2)+(sig.type==="A"?0:1));
    }
    // Compact indexes retain every required EMA/slope pair without duplicating
    // candles or materialising millions of candidate objects. RR/guard reuse it.
    const packed=Uint32Array.from(codes);
    remember(data,data.signals,key,new SignalCandidates(data,ema,packed,cfg.slopeLookback),packed.byteLength+128);
    data.cacheStats.signalCalculations++;
  }
  return data.signals.get(key);
}
export async function prepareMarket(store,cfg,{maxEMA=cfg.emaLength,maxSlope=cfg.slopeLookback,onProgress=()=>{},onPreparationProgress=()=>{},onDataStatus=()=>{},signal,check=()=>{}}={}){
  cfg={...cfg,resolution:"1",expiryType:"WEEKLY"};
  const symbol=SYMBOLS[cfg.symbol];
  const failStage=(stage,activity,unit)=>onPreparationProgress({stage,status:"failed",unit,activity});
  const warm=cfg.emaSeedDate??warmupStart(cfg.startDate,maxEMA,maxSlope,cfg.resolution);
  const requestOptions={signal,onState:onDataStatus,onPreparationProgress};
  onProgress(`Fetching ${cfg.resolution}m strategy SPOT candles: ${warm} to ${cfg.endDate}`);
  check();
  const strategy=(await store.history(symbol,"1",warm,cfg.endDate,{...requestOptions,purpose:"strategy candles 1m"})).filter(c=>{const d=ymdIST(c.t);return d>=warm&&d<=cfg.endDate;});
  onProgress(`Fetching mandatory underlying 5S SPOT candles: ${cfg.startDate} to ${cfg.endDate}`);
  check();
  const monitor=(await store.history(symbol,"5S",cfg.startDate,cfg.endDate,{...requestOptions,purpose:"mandatory underlying execution 5S"})).filter(c=>{const d=ymdIST(c.t);return d>=cfg.startDate&&d<=cfg.endDate;});
  const data=buildDataset(strategy,monitor,{store,symbol,strategyRangeStart:warm});
  const activeDays=new Set(strategy.filter(c=>ymdIST(c.t)>=cfg.startDate&&inSession(c.t)).map(c=>ymdIST(c.t)));
  for(const [day,rows] of data.byDay){
    if(rows.some(c=>inSession(c.t))&&!activeDays.has(day)){failStage("strategy_spot","Strategy candles unavailable for an execution session","chunks");throw new Error(`Strategy candles unavailable on ${day} despite underlying 5S observations; cannot evaluate signals`);}
  }
  for(const day of activeDays){
    const rows=data.byDay.get(day)||[];
    if(!rows.length){failStage("execution_spot","No mandatory 5-second spot candles returned","chunks");throw new Error(`NO 5S DATA RETURNED: No mandatory underlying 5-second candles returned by FYERS for ${day}. Endpoint: GET /data/history; Symbol: ${symbol}; Resolution: 5S; range_from=${day}; range_to=${day}; date_format=1; cont_flag=0. This strategy requires 5S spot data for breakout, Stop Loss and Target; no minute fallback is allowed.`);}
    // Full mandatory trading session must be present. A missing bar could conceal
    // a breakout/stop/target; silently bridging it would change the strategy.
    const start=Date.parse(`${day}T09:15:00+05:30`)/1000,end=Date.parse(`${day}T15:15:00+05:30`)/1000;
    const strategyDay=strategy.filter(c=>ymdIST(c.t)===day);
    let strategyIndex=lowerBound(strategyDay,start);
    for(let t=start;t<end;t+=Number(cfg.resolution)*60){
      if(strategyDay[strategyIndex++]?.t!==t){failStage("strategy_spot","Required 1-minute strategy candle missing during session validation","chunks");throw new Error(`Strategy candle missing at ${new Date(t*1000).toISOString()}; cannot evaluate EMA/signals reliably`);}
    }
    let i=lowerBound(rows,start);
    for(let t=start;t<=end;t+=5){if(rows[i++]?.t!==t){failStage("execution_spot","Mandatory 5-second spot session has a missing candle","chunks");throw new Error(`FYERS 5S HISTORY INCOMPLETE: mandatory underlying candle missing at ${new Date(t*1000).toISOString()} (${day}, IST ${new Date((t+19800)*1000).toISOString().slice(11,19)}); breakout/SL/Target cannot be verified. No interpolation or fallback.`);}}
  }
  if(!activeDays.size){data.noDataDays=true;data.classified=[];data.contractsByExpiry=new Map();onPreparationProgress({stage:"weekly_expiries",status:"complete",completed:0,total:0,unit:"sessions",activity:"No trading sessions require expiry resolution"});onPreparationProgress({stage:"option_contracts",status:"complete",completed:0,total:0,unit:"expiry catalogs",activity:"No option contract catalogs required"});return data;}
  if(strategy.filter(c=>ymdIST(c.t)<cfg.startDate).length<maxEMA+maxSlope){failStage("strategy_spot","Insufficient completed 1-minute warm-up candles","chunks");throw new Error("Insufficient completed strategy candles for EMA/slope warm-up; requested historical data unavailable");}
  let verified={};
  if(process.env.HISTORICAL_CONTRACTS_FILE)verified=JSON.parse(await readFile(process.env.HISTORICAL_CONTRACTS_FILE,"utf8"));
  // Trading remains bounded by the form dates. Expiry lookup extends only to
  // cover expiries applicable to those trading days. The expired-only API must
  // never receive today or a future date in range_to.
  const discoveryStart=cfg.startDate,discoveryEnd=expiryDiscoveryEnd(cfg.endDate,"WEEKLY"),today=ymdIST(Date.now()/1000),lastExpired=addDays(today,-1);
  const dates=new Set(),expiryDiagnostics=[];
  const trace=(details)=>{const row={tradeDateRange:{start:cfg.startDate,end:cfg.endDate},symbol,...details};expiryDiagnostics.push(row);return row;};
  onPreparationProgress({stage:"weekly_expiries",status:"resolving",completed:0,total:activeDays.size,unit:"sessions",activity:`Resolving weekly expiry metadata for ${activeDays.size} trading sessions`});
  const expiredEnd=discoveryEnd<lastExpired?discoveryEnd:lastExpired;
  if(discoveryStart<=expiredEnd){
    for(let from=discoveryStart;from<=expiredEnd;from=addDays(from,366)){
      check();const to=addDays(from,365)<expiredEnd?addDays(from,365):expiredEnd;
      const diagnostic=trace({pathType:"EXPIRED",endpoint:"GET /data/history/fno/expired/expiry-dates",range_from:from,range_to:to,httpStatus:null,fyersCode:null,rawExpiryRecords:0,parsedExpiryRecords:0,weeklyAfterFiltering:0});
      onProgress(`Resolving weekly expiry metadata: expired dates ${from} to ${to}`);
      const response=await store.expiryDates(symbol,from,to,{signal,onState:onDataStatus,purpose:"expired expiry dates for selected trading range",onResponse:meta=>Object.assign(diagnostic,meta)});
      const raw=response.data?.expiry_dates?.options;
      diagnostic.rawExpiryRecords=Array.isArray(raw)?raw.length:null;
      const parsed=extractExpiryDates(response);diagnostic.parsedExpiryRecords=parsed.length;
      if(Array.isArray(raw)&&raw.length&&!parsed.length)throw new Error(`Weekly expiry discovery parser rejected all ${raw.length} expired FYERS expiry records for ${from} to ${to}; response diagnostics=${JSON.stringify(diagnostic)}`);
      for(const d of parsed)dates.add(d);
    }
  }
  const activeStart=discoveryStart>today?discoveryStart:today;
  const needsActive=activeStart<=discoveryEnd;
  let activeExpiries=[];
  if(needsActive&&typeof store.optionChain==="function"){
    onProgress(`Discovering active expiries for selected trading range: ${activeStart} to ${discoveryEnd}`);
    const diagnostic=trace({pathType:"ACTIVE",endpoint:"GET /data/options-chain-v3",range_from:activeStart,range_to:discoveryEnd,httpStatus:null,fyersCode:null,rawExpiryRecords:0,parsedExpiryRecords:0,weeklyAfterFiltering:0});
    const response=await store.optionChain(symbol,{signal,onState:onDataStatus,purpose:"active expiry discovery",onResponse:meta=>Object.assign(diagnostic,meta)});
    const raw=response.data?.expiryData;diagnostic.rawExpiryRecords=Array.isArray(raw)?raw.length:null;
    activeExpiries=extractActiveExpiries(response);diagnostic.parsedExpiryRecords=activeExpiries.length;diagnostic.weeklyAfterFiltering=activeExpiries.filter(x=>x.type==="WEEKLY"&&x.date>=activeStart&&x.date<=discoveryEnd).length;
    if(Array.isArray(raw)&&raw.length&&!activeExpiries.length)throw new Error(`Weekly expiry discovery parser rejected all ${raw.length} active FYERS expiry records for ${activeStart} to ${discoveryEnd}; response diagnostics=${JSON.stringify(diagnostic)}`);
    for(const e of activeExpiries)if(e.date>=activeStart&&e.date<=discoveryEnd)dates.add(e.date);
  }
  const contractsByExpiry=new Map();
  const expiryDates=[...dates].sort();let contractCatalogsCompleted=0;
  onPreparationProgress({stage:"option_contracts",status:expiryDates.length?"resolving":"waiting",completed:0,total:expiryDates.length,unit:"expiry catalogs",activity:expiryDates.length?`Resolving actual option contract catalogs — 0 / ${expiryDates.length} expiries`:"Waiting for weekly expiry metadata"});
  for(const expiry of expiryDates){
    check();onProgress(`Fetching actual option contracts for selected trading range: ${expiry}`);
    onPreparationProgress({stage:"option_contracts",status:"resolving",completed:contractCatalogsCompleted,total:expiryDates.length,unit:"expiry catalogs",activity:`Resolving actual option contracts — expiry ${contractCatalogsCompleted+1} / ${expiryDates.length}: ${expiry}`});
    if(expiry>=today){
      const active=activeExpiries.find(x=>x.date===expiry);
      if(!active)throw new Error(`FYERS active contract metadata does not include required expiry ${expiry} for trading dates ${cfg.startDate} through ${cfg.endDate}`);
      const diagnostic=trace({tradeDateRange:{start:cfg.startDate,end:cfg.endDate},pathType:"ACTIVE",endpoint:"GET /data/options-chain-v3",expiryDate:expiry,httpStatus:null,fyersCode:null,rawContractRecords:0,parsedContractRecords:0,weeklyAfterFiltering:0});
      const chain=await store.optionChain(symbol,active.epoch,{signal,onState:onDataStatus,purpose:"active option contracts for selected expiry",onResponse:meta=>Object.assign(diagnostic,meta)});
      const raw=chain.data?.optionsChain;diagnostic.rawContractRecords=Array.isArray(raw)?raw.length:null;
      const contracts=extractActiveContracts(chain,expiry,active.type,verified);diagnostic.parsedContractRecords=contracts.length;diagnostic.weeklyAfterFiltering=contracts.filter(x=>x.expiryType==="WEEKLY").length;contractsByExpiry.set(expiry,contracts);
    }else{
      const diagnostic=trace({pathType:"EXPIRED",endpoint:"GET /data/history/fno/expired/underlying-symbols",expiryDate:expiry,httpStatus:null,fyersCode:null,rawContractRecords:0,parsedContractRecords:0,weeklyAfterFiltering:0});
      const response=await store.contracts(symbol,expiry,{signal,onState:onDataStatus,purpose:"expired option contracts for selected trading range",onResponse:meta=>Object.assign(diagnostic,meta)});
      const raw=response.data?.contracts?.options;diagnostic.rawContractRecords=Array.isArray(raw)?raw.length:null;
      const contracts=extractContracts(response,expiry,verified);diagnostic.parsedContractRecords=contracts.length;diagnostic.weeklyAfterFiltering=contracts.filter(x=>x.expiryType==="WEEKLY").length;contractsByExpiry.set(expiry,contracts);
    }
    contractCatalogsCompleted++;
    onPreparationProgress({stage:"option_contracts",status:contractCatalogsCompleted===expiryDates.length?"complete":"resolving",completed:contractCatalogsCompleted,total:expiryDates.length,unit:"expiry catalogs",activity:`Actual option contract catalogs — ${contractCatalogsCompleted} / ${expiryDates.length} expiries`});
  }
  data.contractsByExpiry=contractsByExpiry;data.classified=classifyExpiries([...dates].sort(),contractsByExpiry);data.tradingDays=activeDays.size;
  for(const diagnostic of expiryDiagnostics){
    if(diagnostic.pathType==="EXPIRED"&&diagnostic.endpoint.endsWith("expiry-dates"))diagnostic.weeklyAfterFiltering=data.classified.filter(x=>x.type==="WEEKLY"&&x.date>=diagnostic.range_from&&x.date<=diagnostic.range_to).length;
  }
  data.expiryDiagnostics=expiryDiagnostics;data.weeklyExpiryDatesDiscovered=new Set(data.classified.filter(x=>x.type==="WEEKLY").map(x=>x.date)).size;
  // Metadata resolution is a prerequisite even on a no-signal/no-entry run.
  // This verifies the resolver against every session that can be traded without
  // fetching option premiums or contracts for entries that never occur.
  data.applicableExpiryByDay=new Map();
  let expirySessionsCompleted=0;
  for(const day of activeDays){
    const expiry=chooseExpiry(data.classified,day,"WEEKLY");
    if(!expiry){
      const error=new Error(`Weekly expiry resolution failed for trading date ${day} in requested backtest ${cfg.startDate} to ${cfg.endDate}. FYERS expiry diagnostics: ${JSON.stringify(expiryDiagnostics)}`);
      error.incompleteData=true;error.marketData=marketDataSummary(data,cfg);throw error;
    }
    data.applicableExpiryByDay.set(day,expiry);
    expirySessionsCompleted++;
    onPreparationProgress({stage:"weekly_expiries",status:expirySessionsCompleted===activeDays.size?"complete":"resolving",completed:expirySessionsCompleted,total:activeDays.size,unit:"sessions",activity:`Resolving weekly expiry — session ${expirySessionsCompleted} / ${activeDays.size}: ${day}`});
  }
  data.getOptions=async(contract,day,fetchContext={})=>{
    const key=`${contract.symbol}:${cfg.optionResolution}:${day}`;
    if(data.optionsPreparedForOptimization&&!data.optionData.has(key))throw new Error(`Optimisation candidate requested unprepared option history ${key}; candidate evaluation may not fetch FYERS data`);
    if(!data.optionData.has(key)){
      const load=contract.expiryDate>=today?store.activeOptions:store.options;
      if(typeof load!=="function")throw new Error(`FYERS ${contract.expiryDate>=today?"active":"expired"} option-history path is unavailable for ${contract.symbol}`);
      data.optionData.set(key,await load(contract.symbol,cfg.optionResolution,day,day,{signal,onState:onDataStatus,onPremiumDiagnostic:fetchContext.onDiagnostic,
        tradeContext:{tradeDate:day,expiryDate:contract.expiryDate,strike:contract.strike,optionType:contract.optionType,underlyingSpotAtBreakout:fetchContext.atmReferenceSpot,breakoutTimestamp:fetchContext.breakoutTimestamp,requiredEntryTimestamp:fetchContext.requiredEntryTimestamp},
        purpose:`${contract.expiryDate>=today?"active":"expired"} option premium ${contract.symbol} ${day}`}));
    }
    return data.optionData.get(key);
  };
  return data;
}
