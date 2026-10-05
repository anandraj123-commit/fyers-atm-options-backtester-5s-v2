import {validDate} from "./fyers.js";
import {chooseExpiry,chooseATM,contractLotDiagnostic} from "./contracts.js";
import {CHARGE_KEYS,fyersOptionCharges} from "./charges.js";
import {ymdIST,sessionDateEpoch,inSession} from "./time.js";
import {SYMBOLS,marketStore,prepareMarket,candidates,lowerBound,remember,marketDataSummary} from "./market.js";
export {optimise} from "./optimiser.js";
const iso=t=>new Date(t*1000).toISOString();
export const FILL_RULE="First observed option candle OPEN at or after event confirmation (underlying bar end for intrabar touches, bar start for observable opening gaps). Never use a containing candle's earlier open. Entry must fill before pending/session expiry; exits no later than 15:15. Missing 15:15 open stops the run.";
export function normalize(input,optimisation=false){
  const cfg={};
  for(const k of ["symbol","startDate","endDate","optionResolution"])cfg[k]=String(input[k]??(k==="optionResolution"?"1":""));
  // Finalized strategy configuration is enforced server-side, including stale clients.
  cfg.resolution="1";
  cfg.expiryType="WEEKLY";
  if(optimisation){
    cfg.mode=String(input.mode??"FAST");
    if(!["FAST","EXHAUSTIVE"].includes(cfg.mode))throw new Error("Optimisation mode must be FAST or EXHAUSTIVE");
  }
  cfg.minStopLossDistancePct=Number(input.minStopLossDistancePct??0);
  if(!Number.isFinite(cfg.minStopLossDistancePct)||cfg.minStopLossDistancePct<0)throw new Error("Minimum Stop-Loss Distance % must be finite and non-negative");
  if(input.emaSeedDate!==undefined){
    if(!validDate(input.emaSeedDate)||input.emaSeedDate>=cfg.startDate)throw new Error("Invalid EMA seed date for the shared historical snapshot");
    cfg.emaSeedDate=input.emaSeedDate;
  }
  const nums=["startingCapital","lots",...(optimisation?["emaMin","emaMax","emaStep","slopeMin","slopeMax","slopeStep","validMin","validMax","rrMin","rrMax","rrStep","lossMin","lossMax","stopDistanceMin","stopDistanceMax","stopDistanceStep"]:["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses"])];
  for(const k of nums){const fallback=k==="stopDistanceStep" ? .1 : k.startsWith("stopDistance") ? 0 : NaN;cfg[k]=Number(input[k]??fallback);if(!Number.isFinite(cfg[k])||((k.startsWith("stopDistance")?cfg[k]<0:cfg[k]<=0)))throw new Error(`${k} must be a finite ${k.startsWith("stopDistance")?"non-negative":"positive"} number`);}
  for(const k of nums.filter(k=>!["startingCapital","rr","rrMin","rrMax","rrStep","stopDistanceMin","stopDistanceMax","stopDistanceStep"].includes(k)))if(!Number.isSafeInteger(cfg[k]))throw new Error(`${k} must be an integer`);
  if(!SYMBOLS[cfg.symbol])throw new Error("Symbol must be NIFTY or BANKNIFTY");
  cfg.resolution="1";
  if(!["1","5S"].includes(cfg.optionResolution))throw new Error("Option premium resolution must be 1 minute or 5S (separate from underlying execution)");
  cfg.expiryType="WEEKLY";
  if(optimisation&&cfg.stopDistanceMax<cfg.stopDistanceMin)throw new Error("Minimum Stop-Loss Distance range is invalid");
  if(!validDate(cfg.startDate)||!validDate(cfg.endDate)||cfg.startDate>cfg.endDate)throw new Error("Invalid requested date range");
  if(cfg.endDate>=ymdIST(Date.now()/1000))throw new Error("Use completed historical dates ending before today");
  if(cfg.startDate<"2024-10-01")throw new Error("Verified charge schedules start on 2024-10-01; earlier dates are unsupported");
  return cfg;
}
export function findPremium(candles,t,deadline){
  for(let i=lowerBound(candles,t);i<candles.length&&candles[i].t<=deadline;i++){
    const c=candles[i];if(c.o>0&&c.v>0)return {price:c.o,t:c.t};
  }
  return null;
}
export function resultSummary(trades,startingCapital,skipped=[]){
  const sum=k=>trades.reduce((s,t)=>s+(t[k]||0),0),wins=trades.filter(t=>t.netPnl>0),losses=trades.filter(t=>t.netPnl<0);
  let peak=startingCapital,maxDrawdownPct=0,w=0,l=0,maxConsecutiveWins=0,maxConsecutiveLosses=0;
  for(const t of trades){peak=Math.max(peak,t.capitalAfter);maxDrawdownPct=Math.max(maxDrawdownPct,(peak-t.capitalAfter)/peak*100);w=t.netPnl>0?w+1:0;l=t.netPnl<0?l+1:0;maxConsecutiveWins=Math.max(w,maxConsecutiveWins);maxConsecutiveLosses=Math.max(l,maxConsecutiveLosses);}
  const finalCapital=trades.at(-1)?.capitalAfter??startingCapital,netProfit=sum("netProfit"),netLoss=sum("netLoss");
  return {startingCapital,finalCapital,netPnl:finalCapital-startingCapital,totalReturnPct:(finalCapital-startingCapital)/startingCapital*100,
    trades:trades.length,wins:wins.length,losses:losses.length,winRate:trades.length?wins.length/trades.length*100:0,
    grossProfit:sum("grossProfit"),grossLoss:sum("grossLoss"),netProfit,netLoss,
    ...Object.fromEntries(CHARGE_KEYS.map(k=>[`total${k[0].toUpperCase()+k.slice(1)}`,sum(k)])),totalCharges:sum("totalCharges"),
    profitFactor:netLoss?netProfit/-netLoss:netProfit?"Infinity":null,averageWin:wins.length?netProfit/wins.length:0,averageLoss:losses.length?netLoss/losses.length:0,
    largestProfit:wins.length?Math.max(...wins.map(t=>t.netPnl)):0,largestLoss:losses.length?Math.min(...losses.map(t=>t.netPnl)):0,
    maxDrawdownPct,maxConsecutiveWins,maxConsecutiveLosses,skippedCount:skipped.length,ambiguousCount:skipped.filter(s=>s.reason.startsWith("AMBIGUOUS")).length,
    incompleteData:skipped.some(s=>s.unavailable),accuracy:"FYERS_5S_UNDERLYING; OBSERVED_OPTION_OPEN; OHLC_SEQUENCE_UNKNOWN"};
}
export function breakout(data,candidate,cfg){
  const {sc,sig,day,i}=candidate,start=sc.t+Number(cfg.resolution)*60,end=Math.min(start+cfg.entryValidCandles*Number(cfg.resolution)*60,sessionDateEpoch(day,"15:15"));
  const key=`${i}:${sig.side}:${cfg.resolution}`;
  // Find the first cross once through the session. Validity changes only test
  // whether that same first cross falls inside T1..TN; they never rescan 5S bars.
  if(data.breakouts.has(key)){
    const trigger=data.breakouts.get(key);
    return {trigger:trigger&&trigger.barStart<end?trigger:null,start,end};
  }
  const rows=data.byDay.get(day)||[];let trigger=null;
  data.cacheStats.breakoutScans++;
  for(let n=lowerBound(rows,start);n<rows.length&&rows[n].t<sessionDateEpoch(day,"15:15");n++){
    const m=rows[n],cross=spot=>sig.side==="BUY"?spot>sc.h:spot<sc.l;
    if(cross(m.o)){trigger={t:m.t,spot:m.o,barStart:m.t,confirmation:"BAR_OPEN"};break;}
    if(sig.side==="BUY"?m.h>sc.h:m.l<sc.l){trigger={t:m.t+5,spot:m.c,barStart:m.t,confirmation:"BAR_CLOSE",spotSource:"CONFIRMING_5S_CLOSE_PROXY"};break;}
  }
  remember(data,data.breakouts,key,trigger);
  return {trigger:trigger&&trigger.barStart<end?trigger:null,end,start};
}
export function exitEvent(data,candidate,cfg,entry,sl,target){
  const end=sessionDateEpoch(candidate.day,"15:15"),rows=data.byDay.get(candidate.day)||[];
  const key=`${candidate.i}:${candidate.sig.side}:${entry}:${cfg.rr}`;
  if(data.exits.has(key))return data.exits.get(key);
  data.cacheStats.exitScans++;
  let exit;
  for(let n=lowerBound(rows,entry);n<rows.length&&rows[n].t<end;n++){
    const m=rows[n],buy=candidate.sig.side==="BUY";
    const openSL=buy?m.o<=sl:m.o>=sl,openTarget=buy?m.o>=target:m.o<=target;
    if(openSL||openTarget){exit={t:m.t,reason:openSL?"SL":"TARGET",spot:m.o};break;}
    const hitSL=buy?m.l<=sl:m.h>=sl,hitTarget=buy?m.h>=target:m.l<=target;
    if(hitSL||hitTarget){exit={t:m.t+5,reason:hitSL&&hitTarget?"AMBIGUOUS_SL_TARGET_SAME_BAR":hitSL?"SL":"TARGET",spot:m.c};break;}
  }
  if(!exit){const m=rows[lowerBound(rows,end)];if(m?.t!==end)throw new Error(`Required underlying 5S 15:15 open unavailable on ${candidate.day}`);exit={t:end,reason:"15:15",spot:m.o};}
  return remember(data,data.exits,key,exit);
}
export async function simulate(data,cfg,{check=()=>{},yieldEvery=100,onPreparationProgress=()=>{}}={}){
  const trades=[],skipped=[],signals=candidates(data,cfg),pipelineCounters={eligible1mCandles:data.strategy.filter(c=>{const d=ymdIST(c.t);return d>=cfg.startDate&&d<=cfg.endDate&&inSession(c.t);}).length,
    buyASignals:0,buyBSignals:0,sellASignals:0,sellBSignals:0,signalsPassingMinStopDistance:0,pendingSetups:0,breakoutsTriggered:0,entriesRequiringOptions:0,
    weeklyExpiriesResolved:new Set(data.applicableExpiryByDay?.values?.()??[]).size,optionContractsResolved:0,optionPremiumHistoriesLoaded:new Set(),tradesExecuted:0};
  for(const candidate of signals){
    pipelineCounters[candidate.sig.side.toLowerCase()+candidate.sig.type+"Signals"]++;
    const denominator=candidate.sig.side==="BUY"?candidate.sc.h:candidate.sc.l;
    if((candidate.sc.h-candidate.sc.l)/denominator*100>=cfg.minStopLossDistancePct)pipelineCounters.signalsPassingMinStopDistance++;
  }
  const pipelineSnapshot=()=>({...pipelineCounters,optionPremiumHistoriesLoaded:pipelineCounters.optionPremiumHistoriesLoaded.size,tradesExecuted:trades.length});
  const incompleteTradeData=message=>Object.assign(new Error(message),{code:"INCOMPLETE_MARKET_DATA",incompleteData:true,pipelineCounters:pipelineSnapshot(),marketData:marketDataSummary(data,cfg)});
  let capital=cfg.startingCapital,busyUntil=-Infinity,losses=0,lastDay=null,count=0;
  const actualContracts=new Set(),validatedPremiumHistories=new Set();
  for(const candidate of signals){
    check();if(++count%yieldEvery===0)await new Promise(resolve=>setImmediate(resolve));
    const {sc,sig,day,ema,emaPrevious}=candidate,close=sc.t+Number(cfg.resolution)*60,end=sessionDateEpoch(day,"15:15");
    if(day!==lastDay){lastDay=day;losses=0;busyUntil=-Infinity;}
    if(close>=end||close<=busyUntil||losses>=cfg.maxConsecutiveLosses||sc.h<=sc.l)continue;
    const stopDistancePct=(sc.h-sc.l)/(sig.side==="BUY"?sc.h:sc.l)*100;
    if(stopDistancePct<cfg.minStopLossDistancePct)continue;
    pipelineCounters.pendingSetups++;
    const b=breakout(data,candidate,cfg);busyUntil=b.end;
    if(!b.trigger||b.trigger.t>=b.end)continue;
    pipelineCounters.breakoutsTriggered++;pipelineCounters.entriesRequiringOptions++;
    const trigger=b.trigger,expiryKey=`${day}:${cfg.expiryType}`;
    if(!data.expirySelections.has(expiryKey))remember(data,data.expirySelections,expiryKey,chooseExpiry(data.classified,day,cfg.expiryType));
    const expiry=data.expirySelections.get(expiryKey);
    const skip=(reason,unavailable=false,more={})=>skipped.push({day,signalTime:iso(sc.t),reason,unavailable,...more});
    if(!expiry)throw incompleteTradeData(`Required weekly expiry unavailable for breakout on ${day}; backtest cannot use an incomplete weekly-options dataset`);
    const optType=sig.side==="BUY"?"CE":"PE",contractKey=`${expiry}:${cfg.expiryType}:${optType}:${trigger.spot}`;
    onPreparationProgress({stage:"option_contracts",status:"resolving",completed:actualContracts.size,total:null,unit:"contracts",activity:`Resolving ATM weekly ${optType} contract for ${day}`});
    if(!data.contractSelections.has(contractKey)){
      remember(data,data.contractSelections,contractKey,chooseATM(data.contractsByExpiry.get(expiry)||[],trigger.spot,optType,cfg.expiryType));
      data.cacheStats.contractSelections++;
    }
    const contract=data.contractSelections.get(contractKey);
    if(!contract)throw incompleteTradeData(`Required actual ATM ${optType} weekly contract unavailable for expiry ${expiry} on ${day}; no substitute contract is allowed`);
    if(!contract.lotSize)throw incompleteTradeData(`Historical lot size unavailable for required contract ${contract.symbol} on ${day}; no current lot-size fallback is allowed. Safe contract metadata: ${JSON.stringify(contractLotDiagnostic(contract))}`);
    actualContracts.add(contract.symbol);
    onPreparationProgress({stage:"option_contracts",status:"resolving",completed:actualContracts.size,total:null,unit:"contracts",activity:`ATM option contract resolved — ${contract.symbol} (${actualContracts.size} resolved; total not yet known)`});
    pipelineCounters.optionContractsResolved++;
    const historyKey=`${contract.symbol}:${day}`;
    onPreparationProgress({stage:"option_premiums",status:"fetching",completed:validatedPremiumHistories.size,total:null,unit:"histories",activity:`Fetching historical option premium — ${contract.symbol} — ${day}`});
    let oc;try{oc=await data.getOptions(contract,day);}catch(error){throw incompleteTradeData(error.message);}
    pipelineCounters.optionPremiumHistoriesLoaded.add(`${contract.symbol}:${day}`);
    if(!oc.length)throw incompleteTradeData(`FYERS ${cfg.optionResolution} option premium data unavailable: ${contract.symbol} ${day}. No premium fabricated.`);
    const ep=findPremium(oc,trigger.t,b.end-1);
    if(!ep)throw incompleteTradeData(`Required option entry premium unavailable after breakout for ${contract.symbol} on ${day}; no premium may be fabricated`);
    // The pending entry occupies time until its actual premium fill. Risk monitoring
    // starts only at that fill, never in the bar before the position existed.
    const risk=sc.h-sc.l,sl=sig.side==="BUY"?sc.l:sc.h,target=sig.side==="BUY"?sc.h+risk*cfg.rr:sc.l-risk*cfg.rr;
    const exit=exitEvent(data,candidate,cfg,ep.t,sl,target);
    if(exit.reason.startsWith("AMBIGUOUS")){
      // Preserve exclusion of ambiguous trades; reserve the remainder of the session
      // because their P&L/loss-guard state cannot be known. No favourable re-entry.
      busyUntil=end;validatedPremiumHistories.add(historyKey);onPreparationProgress({stage:"option_premiums",status:"fetching",completed:validatedPremiumHistories.size,total:null,unit:"histories",activity:`Option premium history validated — ${contract.symbol} — ${validatedPremiumHistories.size} histories loaded`});skip(exit.reason,false,{contract:contract.symbol,eventTime:iso(exit.t),entryTime:iso(ep.t),optionEntryPremium:ep.price,handling:"EXCLUDED_FROM_PNL; DAY_BLOCKED_SEQUENCE_UNKNOWN"});continue;
    }
    const xp=findPremium(oc,exit.t,end);
    if(!xp)throw incompleteTradeData(`No temporally valid ${cfg.optionResolution} option exit open by 15:15 for ${contract.symbol} on ${day}; cannot close without fabricating a premium`);
    validatedPremiumHistories.add(historyKey);
    onPreparationProgress({stage:"option_premiums",status:"fetching",completed:validatedPremiumHistories.size,total:null,unit:"histories",activity:`Option premium history validated — ${contract.symbol} — ${validatedPremiumHistories.size} histories loaded`});
    busyUntil=xp.t;
    const qty=cfg.lots*contract.lotSize,gross=(xp.price-ep.price)*qty,charges=fyersOptionCharges({buyPrice:ep.price,sellPrice:xp.price,qty,tradeDate:day}),net=gross-charges.total,before=capital;
    capital+=net;
    const rows=data.byDay.get(day),entrySpot=rows[lowerBound(rows,ep.t)],exitSpot=rows[lowerBound(rows,xp.t)];
    if(entrySpot?.t!==ep.t||exitSpot?.t!==xp.t)throw incompleteTradeData("Underlying 5S observation missing at option fill timestamp");
    trades.push({tradeNo:trades.length+1,date:day,tradeDate:day,underlying:cfg.symbol,direction:sig.side,setup:sig.type,optionType:optType,positionSide:"LONG",expiryType:cfg.expiryType,expiryDate:expiry,
      signalTime:iso(sc.t),signalOpen:sc.o,signalHigh:sc.h,signalLow:sc.l,signalClose:sc.c,ema,emaSlope:ema-emaPrevious,emaSlopeDirection:sig.side==="BUY"?"UP":"DOWN",
      breakoutPrice:sig.side==="BUY"?sc.h:sc.l,breakoutConfirmedTime:iso(trigger.t),breakoutConfirmation:trigger.confirmation,atmReferenceSpot:trigger.spot,atmReferenceSource:trigger.spotSource??"OBSERVED_5S_OPEN",
      entryTime:iso(ep.t),spotEntry:entrySpot.o,atmStrike:contract.strike,contract:contract.symbol,optionEntryPremium:ep.price,lots:cfg.lots,configuredLots:cfg.lots,lotSize:contract.lotSize,historicalLotSize:contract.lotSize,lotSizeSource:contract.lotSizeSource,lotSizeMetadataField:contract.lotSizeMetadataField??null,lotSizeMetadataValue:contract.lotSizeMetadataValue??null,quantity:qty,actualQuantity:qty,
      underlyingSL:sl,underlyingTarget:target,exitEventTime:iso(exit.t),exitTime:iso(xp.t),spotExit:exitSpot.o,optionExitPremium:xp.price,exitReason:exit.reason,
      grossPnl:gross,grossProfit:Math.max(0,gross),grossLoss:Math.min(0,gross),...Object.fromEntries(CHARGE_KEYS.map(k=>[k,charges[k]])),totalCharges:charges.total,
      netPnl:net,netProfit:Math.max(0,net),netLoss:Math.min(0,net),capitalAfter:capital,tradeReturnPct:before>0?net/before*100:null,
      underlyingResolution:"5S",optionPriceResolution:cfg.optionResolution,optionPriceAccuracy:cfg.optionResolution==="5S"?"FYERS_5_SECOND_OHLC_OPEN":"FYERS_1_MINUTE_OHLC_OPEN",
      fillRule:FILL_RULE,source:"FYERS_HISTORY_AND_EXPIRED_FNO",expiryTypeSource:contract.expiryTypeSource});
    losses=net<0?losses+1:0;
  }
  pipelineCounters.optionPremiumHistoriesLoaded=pipelineCounters.optionPremiumHistoriesLoaded.size;
  pipelineCounters.tradesExecuted=trades.length;
  onPreparationProgress({stage:"option_contracts",status:"complete",completed:actualContracts.size,total:actualContracts.size,unit:"contracts",activity:`Required ATM option contracts resolved — ${actualContracts.size} / ${actualContracts.size}`});
  onPreparationProgress({stage:"option_premiums",status:"complete",completed:validatedPremiumHistories.size,total:validatedPremiumHistories.size,unit:"histories",activity:`Required option premium histories validated — ${validatedPremiumHistories.size} / ${validatedPremiumHistories.size}`});
  return {config:cfg,summary:resultSummary(trades,cfg.startingCapital,skipped),marketData:marketDataSummary(data,cfg),pipelineCounters,trades,skipped};
}
export async function backtest(token,input,options={}){
  const cfg=normalize(input);let data=options.data;
  try{
    if(!data)data=await prepareMarket(options.store??marketStore(token),cfg,options);
    return await simulate(data,cfg,options);
  }catch(error){
    const wrapped=new Error(`Required market data or trade prices are incomplete. The backtest was not run. ${error.message}`);
    wrapped.code="MARKET_DATA_PREPARATION";wrapped.incompleteData=true;wrapped.pipelineCounters=error.pipelineCounters;wrapped.marketData=error.marketData;wrapped.cause=error;throw wrapped;
  }
}
