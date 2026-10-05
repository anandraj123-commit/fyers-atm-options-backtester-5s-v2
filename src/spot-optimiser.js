import {normalizeSpot,prepareSpotData,runSpotBacktestAsync,spotRequestCounters} from "./spot-engine.js";
import {dimension} from "./optimiser.js";

const keys=["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses","minStopLossDistancePct"];
export function spotSearchPlan(cfg){
  const dims=[dimension(cfg.emaMin,cfg.emaMax,cfg.emaStep,"EMA Length"),dimension(cfg.slopeMin,cfg.slopeMax,cfg.slopeStep,"Slope Lookback"),dimension(cfg.validMin,cfg.validMax,1,"Entry Valid Candles"),dimension(cfg.rrMin,cfg.rrMax,cfg.rrStep,"RR"),dimension(cfg.lossMin,cfg.lossMax,1,"Max Consecutive Losses / Day"),dimension(cfg.stopDistanceMin,cfg.stopDistanceMax,cfg.stopDistanceStep,"Minimum Stop-Loss Distance %",{allowZero:true})];
  const total=dims.reduce((n,d)=>n*BigInt(d.count),1n);return {dims,total,requested:total<=BigInt(Number.MAX_SAFE_INTEGER)?Number(total):String(total)};
}
function* cartesian(axes,depth=0,prefix=[]){if(depth===axes.length){yield prefix;return;}for(const i of axes[depth])yield*cartesian(axes,depth+1,[...prefix,i]);}
function coarse(n){return [...new Set(Array.from({length:Math.min(4,n)},(_,i)=>n===1?0:Math.round(i*(n-1)/(Math.min(4,n)-1))))];}
export function* spotCandidates(plan,limit=12000){
  const counts=plan.dims.map(d=>d.count),seen=new Set(),leaders=[];
  function* scan(axes,stage){for(const ix of cartesian(axes)){if(seen.size>=limit)return;const key=ix.join(":");if(seen.has(key))continue;seen.add(key);const parameters=Object.fromEntries(keys.map((k,i)=>[k,plan.dims[i].value(ix[i])]));const outcome=yield {parameters,stage,indexes:ix};if(outcome?.eligible){leaders.push({outcome,indexes:ix});leaders.sort((a,b)=>compareSpot(a.outcome,b.outcome));if(leaders.length>8)leaders.pop();}}}
  const broad=counts.map(coarse);yield*scan(broad,"Broad Search");if(!leaders.length||seen.size>=limit)return;
  let radii=counts.map(n=>n===1?0:Math.max(1,Math.ceil((n-1)/3))),round=0;
  while(true){for(const center of leaders.map(x=>x.indexes)){const axes=counts.map((n,i)=>[...new Set([center[i]-radii[i],center[i],center[i]+radii[i]].filter(v=>v>=0&&v<n))].sort((a,b)=>a-b));yield*scan(axes,`Refinement Round ${++round}`);if(seen.size>=limit)return;}if(radii.every(x=>x<=1))break;radii=radii.map(x=>x?Math.max(1,Math.floor(x/2)):0);}
  for(const center of leaders.map(x=>x.indexes)){yield*scan(counts.map((n,i)=>[center[i]-1,center[i],center[i]+1].filter(v=>v>=0&&v<n)),"Final Refinement");if(seen.size>=limit)return;}
}
const stable=(a,b)=>{for(const k of ["emaLength","slopeLookback","entryValidCandles","rr","minStopLossDistancePct","maxConsecutiveLosses"]){const x=Number(a[k]),y=Number(b[k]);if(x!==y)return x-y;}return 0;};
export function compareSpot(a,b){return b.expectancyR-a.expectancyR||b.resolvedTrades-a.resolvedTrades||b.winRatePct-a.winRatePct||stable(a,b);}
function* exhaustive(plan,depth=0,parameters={}){
  if(depth===plan.dims.length){yield {parameters,stage:"Exhaustive Search"};return;}
  const d=plan.dims[depth];for(let i=0;i<d.count;i++)yield* exhaustive(plan,depth+1,{...parameters,[keys[depth]]:d.value(i)});
}
// Max-heap retains the best 10,000 candidates in O(log cap) per result.
function retain(heap,row,cap=10000){
  if(heap.length<cap){heap.push(row);let i=heap.length-1;while(i){const p=(i-1)>>1;if(compareSpot(heap[p],heap[i])>=0)break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p;}return;}
  if(compareSpot(row,heap[0])>=0)return;heap[0]=row;let i=0;
  for(;;){let worst=i,l=i*2+1,r=l+1;if(l<heap.length&&compareSpot(heap[l],heap[worst])>0)worst=l;if(r<heap.length&&compareSpot(heap[r],heap[worst])>0)worst=r;if(worst===i)return;[heap[i],heap[worst]]=[heap[worst],heap[i]];i=worst;}
}
export async function optimiseSpot(token,input,options={}){
  const cfg=normalizeSpot(input,true),plan=spotSearchPlan(cfg),started=Date.now(),diagnosticCounters=spotRequestCounters(),limit=Number(options.fastLimit??process.env.SPOT_FAST_CANDIDATE_LIMIT??12000);
  const retained=[];let lastPublished=0;
  const state={status:"preparing_data",mode:cfg.mode,requested:plan.requested,evaluated:0,bestResult:null,stage:"Fetching 1-Minute Spot Data",progressPct:0,elapsed:0,historyRequests:diagnosticCounters,progress:{}};
  const publish=()=>{lastPublished=Date.now();state.results=[...retained].sort(compareSpot);state.elapsed=(Date.now()-started)/1000;state.historyRequests={...diagnosticCounters};options.onProgress?.({...state});};
  const check=()=>{if(options.signal?.aborted){const e=new Error("Spot optimisation cancelled");e.code="CANCELLED";throw e;}};
  publish();
  try{
    check();if(!Number.isSafeInteger(limit)||limit<1)throw new Error("FAST candidate limit must be a positive integer");
    const data=options.data??await prepareSpotData(token,cfg,{store:options.store,signal:options.signal,check,diagnosticCounters,onProgress:event=>{state.progress[event.stage]={...event};state.status="preparing_data";state.stage=event.stage;state.currentActivity=event.activity;state.preparationProgress=event;publish();}});
    state.status="running";state.stage="preparing_optimisation";state.currentActivity=`Prepared one 1-minute spot dataset (${data.candles.length} candles)`;state.preparationProgress={stage:"preparing_optimisation",status:"complete",completed:1,total:1,unit:"dataset",activity:"Reusable 1-minute market data prepared once"};state.progress.preparing_optimisation=state.preparationProgress;state.dataSummary={candles:data.candles.length,warmupStart:data.warmupStart};publish();
    const search=cfg.mode==="FAST"?spotCandidates(plan,limit):exhaustive(plan);let next=search.next(),evalByStage=0,stageName=null;
    while(!next.done){check();if(stageName!==next.value.stage){stageName=next.value.stage;evalByStage=0;}state.status="running";state.stage="evaluating_candidates";state.fastStage=next.value.stage;state.currentActivity=`Evaluating ${cfg.mode} spot optimisation — ${stageName}`;const result=await runSpotBacktestAsync(data,{...cfg,...next.value.parameters},{check});
      options.onCandidate?.(result);
      const row={...next.value.parameters,signals:result.summary.totalSignals,entries:result.summary.totalEntries,targetHits:result.summary.targetHits,slHits:result.summary.slHits,eodExits:result.summary.eodExits,winRatePct:result.summary.resolvedWinRatePct,targetHitRatePct:result.summary.targetHitRateAllEntriesPct,expectancyR:result.summary.expectancyR,resolvedTrades:result.summary.targetHits+result.summary.slHits,maximumConsecutiveLosses:result.summary.maximumConsecutiveLosses,summary:result.summary,eligible:Number.isFinite(result.summary.expectancyR)};
      state.evaluated++;evalByStage++;if(!state.bestResult||compareSpot(row,state.bestResult)<0)state.bestResult=row;
      // Keep compact result records; the search is streamed and candidate result
      // retention is bounded independently from evaluation.
      retain(retained,row);
      const broadTotal=Math.min(limit,plan.dims.reduce((n,d)=>n*Math.min(4,d.count),1));const total=cfg.mode==="EXHAUSTIVE"?plan.requested:stageName==="Broad Search"?broadTotal:null;
      state.evaluationProgress={status:"processing",completed:evalByStage,total,unit:"candidates",percentage:total?Math.floor(evalByStage/total*10000)/100:null,stage:stageName};
      state.progressPct=cfg.mode==="EXHAUSTIVE"?Number(BigInt(state.evaluated)*10000n/plan.total)/100:null;
      if(Date.now()-lastPublished>=250||state.evaluated===1){publish();await new Promise(resolve=>setImmediate(resolve));}
      next=search.next(row);
    }
    check();if(!state.evaluated)throw new Error("No candidates evaluated");
    state.progress.evaluating_candidates={...state.evaluationProgress,status:"complete"};
    state.stage="finalising_best_result";state.preparationProgress={stage:"finalising_best_result",status:"processing",completed:0,total:null,unit:"result",activity:"Finalising best spot strategy result"};state.currentActivity=state.preparationProgress.activity;publish();
    await new Promise(resolve=>setImmediate(resolve));check();
    state.results?.sort(compareSpot);state.status="complete";state.exhaustive=cfg.mode==="EXHAUSTIVE"&&BigInt(state.evaluated)===plan.total;state.evaluationProgress={completed:state.evaluated,total:cfg.mode==="EXHAUSTIVE"?plan.requested:state.evaluated,unit:"candidates",percentage:100};state.preparationProgress={stage:"finalising_best_result",status:"complete",completed:1,total:1,unit:"result",activity:"Best result ready"};state.progress.finalising_best_result=state.preparationProgress;state.stage="complete";state.currentActivity="Spot optimisation complete";publish();
  }catch(error){state.results?.sort(compareSpot);state.status=options.signal?.aborted||error.code==="CANCELLED"?"cancelled":state.evaluated?"incomplete":"failed";const failedStage=state.preparationProgress?.stage??state.stage;state.stage=state.status==="cancelled"?"Cancelled":"Interrupted";state.reason=state.evaluated?error.message:`Spot market data/candidate preparation failed; no candidates evaluated. ${error.message}`;if(state.status==="failed")state.preparationProgress={...(state.preparationProgress??{}),stage:failedStage,status:"failed",activity:error.message};state.progress.finalising_best_result={stage:"finalising_best_result",status:"blocked",activity:state.evaluated?"Interrupted before completion":"NOT RUN / BLOCKED — zero candidates evaluated"};state.exhaustive=false;publish();}
  return state;
}
