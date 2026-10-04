import {normalize,simulate,breakout} from "./engine.js";
import {marketStore,prepareMarket,warmupStart,marketDataSummary,candidates} from "./market.js";
import {chooseExpiry,chooseATM} from "./contracts.js";
import {historyRequestDiagnostics} from "./fyers.js";
import {createResultStore,compareResults} from "./results.js";

const PARAMS=["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses","minStopLossDistancePct"];
function decimal(value){
  const [mantissa,power="0"]=String(value).toLowerCase().split("e"),fraction=mantissa.split(".")[1]?.length??0;
  return {coefficient:BigInt(mantissa.replace(".","")),scale:fraction-Number(power)};
}
export function dimension(min,max,step,name,{allowZero=false}={}){
  if(![min,max,step].every(Number.isFinite)||step<=0||(allowZero?min<0:min<=0)||max<min)throw new Error(`${name}: require ${allowZero?"non-negative":"positive"} min, positive step and max >= min`);
  const parts=[min,max,step].map(decimal),scale=Math.max(0,...parts.map(x=>x.scale));
  const [lo,hi,increment]=parts.map(x=>x.coefficient*10n**BigInt(scale-x.scale));
  const size=(hi-lo)/increment+1n;
  if(size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error(`${name}: range exceeds safe integer precision`);
  return {name,min,max,step,count:Number(size),value:i=>Number(`${lo+BigInt(i)*increment}e-${scale}`)};
}
export function searchPlan(cfg){
  const dims=[dimension(cfg.emaMin,cfg.emaMax,cfg.emaStep,"EMA Length"),dimension(cfg.slopeMin,cfg.slopeMax,cfg.slopeStep,"Slope Lookback"),dimension(cfg.validMin,cfg.validMax,1,"Entry Valid Candles"),dimension(cfg.rrMin,cfg.rrMax,cfg.rrStep,"RR"),dimension(cfg.lossMin,cfg.lossMax,1,"Max Consecutive Losses / Day"),dimension(cfg.stopDistanceMin,cfg.stopDistanceMax,cfg.stopDistanceStep,"Minimum Stop-Loss Distance %",{allowZero:true})];
  const expiries=["WEEKLY"];
  const total=dims.reduce((n,d)=>n*BigInt(d.count),1n);
  return {dims,expiries,total,totalCombinations:total<=BigInt(Number.MAX_SAFE_INTEGER)?Number(total):String(total),
    dimensions:dims.map(({name,count,min,max,step})=>({name,count,min,max,step}))};
}
function parametersAt(plan,indexes){return {...Object.fromEntries(PARAMS.map((k,i)=>[k,plan.dims[i].value(indexes[i])])),expiryType:"WEEKLY"};}
function* cartesian(axes,depth=0,prefix=[]){
  if(depth===axes.length){yield prefix;return;}
  for(const index of axes[depth])yield* cartesian(axes,depth+1,[...prefix,index]);
}
export function* combinations(plan){
  // No axes or Cartesian product arrays proportional to the requested search size.
  const [e,s,v,r,l,d]=plan.dims;
  for(let i=0;i<e.count;i++)for(let j=0;j<s.count;j++)for(let k=0;k<v.count;k++)for(let n=0;n<r.count;n++)for(let m=0;m<l.count;m++)for(let p=0;p<d.count;p++)
    yield {emaLength:e.value(i),slopeLookback:s.value(j),entryValidCandles:v.value(k),rr:r.value(n),maxConsecutiveLosses:l.value(m),minStopLossDistancePct:d.value(p),expiryType:"WEEKLY"};
}
function* exhaustiveSearch(plan){for(const parameters of combinations(plan))yield {parameters,stage:"Exhaustive Search"};}
async function prepareOptimizationOptions(data,cfg,plan,{check=()=>{},onProgress=()=>{}}={}){
  const [emas,slopes,valid]=plan.dims,validity=valid.value(valid.count-1),minimum=plan.dims[5].value(0),seenPairs=emas.count*slopes.count;
  let pair=0,required=0;
  for(let ei=0;ei<emas.count;ei++)for(let si=0;si<slopes.count;si++){
    check();const emaLength=emas.value(ei),slopeLookback=slopes.value(si),signalCfg={...cfg,emaLength,slopeLookback,entryValidCandles:validity,minStopLossDistancePct:minimum};
    for(const candidate of candidates(data,signalCfg)){
      const {sc,sig,day}=candidate,stopPct=(sc.h-sc.l)/(sig.side==="BUY"?sc.h:sc.l)*100;
      if(stopPct<minimum)continue;
      const pending=breakout(data,candidate,signalCfg);if(!pending.trigger||pending.trigger.t>=pending.end)continue;
      const expiry=chooseExpiry(data.classified,day,"WEEKLY");if(!expiry)throw new Error(`Required weekly expiry unavailable for breakout on ${day}`);
      const optionType=sig.side==="BUY"?"CE":"PE",contract=chooseATM(data.contractsByExpiry.get(expiry)||[],pending.trigger.spot,optionType,"WEEKLY");
      if(!contract)throw new Error(`Required actual ATM ${optionType} weekly contract unavailable for ${expiry} on ${day}`);
      if(!contract.lotSize)throw new Error(`Historical lot size unavailable for required contract ${contract.symbol} on ${day}`);
      const optionRows=await data.getOptions(contract,day),fill=optionRows.find(row=>row.t>=pending.trigger.t&&row.t<pending.end&&row.o>0&&row.v>0);
      if(!fill)throw new Error(`Required option entry premium unavailable after breakout for ${contract.symbol} on ${day}`);
      required++;
    }
    if(++pair%10===0){onProgress(`Preparing required weekly option premiums (${pair}/${seenPairs} EMA/slope pairs)`);await new Promise(resolve=>setImmediate(resolve));}
  }
  data.optionsPreparedForOptimization=true;return required;
}
function coarseIndexes(count){return [...new Set(Array.from({length:Math.min(4,count)},(_,i)=>count===1?0:Math.round(i*(count-1)/(Math.min(4,count)-1))))];}
export function* fastSearch(plan,limit=12000){
  // Deterministic four-point grid, then eight winning regions with shrinking
  // index radii. Every point belongs to the user's exact stepped grid. The search
  // budget bounds only this explicitly non-exhaustive method, never EXHAUSTIVE.
  const seen=new Set(),regions=[],counts=plan.dims.map(d=>d.count);
  function* visit(axes,stage){
    for(const indexes of cartesian(axes)){
      if(seen.size>=limit)return;
      const key=indexes.join(":");if(seen.has(key))continue;seen.add(key);
      const row=yield {parameters:parametersAt(plan,indexes),stage};
      if(row?.eligible){regions.push({row,indexes});regions.sort((a,b)=>compareResults(a.row,b.row));if(regions.length>8)regions.pop();}
    }
  }
  yield* visit(counts.map(coarseIndexes),"Broad Search");
  if(!regions.length||seen.size>=limit)return;
  let radii=counts.map(n=>n===1?0:Math.max(1,Math.ceil((n-1)/3))),level=0;
  for(;;){
    const centers=regions.map(r=>r.indexes);
    for(const center of centers){
      const axes=counts.map((n,i)=>[...new Set([center[i]-radii[i],center[i],center[i]+radii[i]].filter(x=>x>=0&&x<n))].sort((a,b)=>a-b));
      yield* visit(axes,`Refinement ${++level}`);
      if(seen.size>=limit)return;
    }
    if(radii.every(r=>r<=1))break;
    radii=radii.map(r=>r?Math.max(1,Math.floor(r/2)):0);
  }
  // Two final local passes allow a winning region to move to an adjacent grid point.
  for(let pass=1;pass<=2;pass++)for(const center of regions.map(r=>r.indexes)){
    // Weekly expiry is fixed, so only the six searchable numerical dimensions
    // have indexes here (there is no expiry axis to append).
    yield* visit(counts.map((n,i)=>[center[i]-1,center[i],center[i]+1].filter(x=>x>=0&&x<n)),`Fine Refinement ${pass}`);
    if(seen.size>=limit)return;
  }
}
export async function optimise(token,input,options={}){
  const cfg=normalize(input,true),plan=searchPlan(cfg),started=Date.now();
  cfg.emaSeedDate??=warmupStart(cfg.startDate,cfg.emaMax,cfg.slopeMax,cfg.resolution);
  const maxSeconds=Number(options.maxSeconds??process.env.OPTIMISATION_MAX_SECONDS??600);
  const maxBytes=Number(options.maxBytes??process.env.OPTIMISATION_MAX_RESULT_BYTES??536870912);
  const cacheBudget=Number(options.cacheBudget??process.env.OPTIMISATION_MAX_CACHE_BYTES??268435456);
  const fastLimit=Number(options.fastLimit??process.env.OPTIMISATION_FAST_CANDIDATES??12000);
  if(!Number.isFinite(maxSeconds)||maxSeconds<=0||!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(cacheBudget)||cacheBudget<=0||!Number.isSafeInteger(fastLimit)||fastLimit<=0)throw new Error("Invalid optimisation server resource budgets");
  const state={status:"preparing_data",mode:cfg.mode,stage:"Preparing Market Data",objective:"MAXIMUM_NET_TOTAL_RETURN_PERCENTAGE",resolution:cfg.resolution,config:cfg,
    requested:plan.totalCombinations,dimensions:plan.dimensions,evaluated:0,storedResults:0,elapsed:0,progressPct:0,estimatedRemaining:null,
    exhaustive:false,bestResult:null,unavailableCandidates:0,retentionLimited:false,fastCandidateBudget:cfg.mode==="FAST"?fastLimit:null};
  let store=null,storageFailed=false,finalized=false,evalMs=0,data;
  const progress=()=>{
    state.elapsed=(Date.now()-started)/1000;
    state.progressPct=Number(BigInt(state.evaluated)*1000000n/plan.total)/10000;
    state.storedResults=(store?.count??0)+(!finalized&&state.bestResult&&!store?.contains?.(state.bestResult)?1:0);
    if(storageFailed)state.storedResults=state.bestResult?1:0;
    state.retentionLimited=storageFailed||!!store?.limited;
    state.historyRequests=historyRequestDiagnostics();
    // Keep existing API consumers working while providing the explicit job schema.
    Object.assign(state,{totalCombinations:state.requested,processed:state.evaluated,materialisedRows:state.storedResults,elapsedSeconds:state.elapsed,estimatedRemainingSeconds:state.estimatedRemaining,best:state.bestResult});
    options.onProgress?.({...state});
  };
  const check=()=>{
    if(options.signal?.aborted){const e=new Error("Optimisation cancelled; no further candidates evaluated.");e.code="CANCELLED";throw e;}
    if((Date.now()-started)/1000>=maxSeconds){const e=new Error(`Runtime budget of ${maxSeconds}s reached; search is INCOMPLETE.`);e.code="TIME_BUDGET";throw e;}
  };
  const storageFailure=()=>{storageFailed=true;store=null;options.onStore?.(null);state.retentionWarning="Result storage unavailable; evaluation continues. Best result remains in job status.";};
  progress();
  try{
    try{store=options.resultStore??await createResultStore({maxBytes});options.onStore?.(store);}catch{storageFailure();}
    data=options.data??await prepareMarket(options.store??marketStore(token),cfg,{maxEMA:cfg.emaMax,maxSlope:cfg.slopeMax,check,signal:options.signal,
      onProgress:message=>{state.message=message;state.status="preparing_data";progress();},
      onDataStatus:status=>{if(status.status==="waiting_rate_limit"){state.status="waiting_rate_limit";state.stage="Preparing Market Data";state.message=`FYERS request limit reached. Waiting before retry. Retry ${status.retry}/${status.maxRetries}`;progress();}}});
    data.cacheBudget=cacheBudget;state.marketData=marketDataSummary(data,cfg);delete state.message;
    state.status="preparing_data";state.stage="Preparing Required Weekly Option Premiums";progress();
    state.requiredOptionCandidates=await prepareOptimizationOptions(data,cfg,plan,{check,onProgress:message=>{state.message=message;progress();}});
    state.marketData=marketDataSummary(data,cfg);delete state.message;state.status="running";
    const search=cfg.mode==="FAST"?fastSearch(plan,fastLimit):exhaustiveSearch(plan);
    let next=search.next(),lastPublish=0;
    while(!next.done){
      check();state.status="running";state.stage=next.value.stage;
      if(state.evaluated===0)progress();
      const parameters=next.value.parameters,tick=performance.now();
      const result=await (options.evaluate??simulate)(data,{...cfg,...parameters},{check});
      evalMs+=performance.now()-tick;
      const returnPct=result.summary.incompleteData?null:result.summary.totalReturnPct;
      if(returnPct!==null&&!Number.isFinite(returnPct))throw new Error("Candidate returned a non-finite return; search is incomplete");
      const row={combination:state.evaluated+1,...parameters,maxConsecutiveLossesPerDay:parameters.maxConsecutiveLosses,resolution:cfg.resolution,returnPct,totalReturnPct:returnPct,
        netPnl:result.summary.netPnl,totalCharges:result.summary.totalCharges,trades:result.summary.trades,skippedCount:result.skipped.length,ambiguousCount:result.summary.ambiguousCount,
        eligible:returnPct!==null,status:returnPct===null?"DATA_UNAVAILABLE":"EVALUATED",reason:result.skipped.find(x=>x.unavailable)?.reason??""};
      state.evaluated++;
      if(!row.eligible)state.unavailableCandidates++;
      if(row.eligible&&(!state.bestResult||compareResults(row,state.bestResult)<0))state.bestResult=row;
      state.marketData=marketDataSummary(data,cfg);
      if(store)try{await store.add(row);}catch{storageFailure();}
      state.estimatedRemaining=cfg.mode==="EXHAUSTIVE"?evalMs/state.evaluated*(Number(plan.total)-state.evaluated)/1000:null;
      if(!Number.isFinite(state.estimatedRemaining))state.estimatedRemaining=null;
      // Polling/cancellation can run even if all underlying data is already cached.
      if(state.evaluated%10===0||Date.now()-lastPublish>=100){progress();lastPublish=Date.now();await new Promise(resolve=>setImmediate(resolve));}
      check();next=search.next(row);
    }
    state.status="complete";
    state.exhaustive=cfg.mode==="EXHAUSTIVE"&&BigInt(state.evaluated)===plan.total;
    state.stage="Finished";
    if(cfg.mode==="FAST")state.reason=`FAST completed a deterministic non-exhaustive search (${state.evaluated} candidates). No global optimum is guaranteed.`;
  }catch(e){
    const preparing=state.status==="preparing_data"||state.status==="waiting_rate_limit";
    state.status=e.code==="CANCELLED"?"cancelled":state.evaluated===0&&preparing&&e.code!=="CACHE_BUDGET_EXCEEDED"?"failed":"incomplete";
    state.reason=state.status==="failed"?`Mandatory FYERS market data could not be prepared. No optimisation candidates were evaluated. ${e.message}`:e.message;state.stage=e.code==="CANCELLED"?"Cancelled":"Interrupted";
    state.exhaustive=false;
  }
  if(data)state.cacheStats={...data.cacheStats,bytes:data.cacheBytes};
  if(store){
    const terminalStage=state.stage;state.stage="Sorting Retained Results";state.sorting=true;progress();
    try{await store.finalize(state.bestResult);finalized=true;}catch{storageFailure();}
    state.sorting=false;state.stage=terminalStage;
  }
  state.exportAvailable=!!store?.file;progress();
  return {...state,store};
}
