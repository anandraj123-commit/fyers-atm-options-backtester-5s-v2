const $=s=>document.querySelector(s);
const escapeHtml=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const resolutionLabel=()=>"1 Minute";
const formatReturn=x=>`${Number(x)>=0?"+":""}${Number(x).toFixed(2)}%`;
const formatCount=x=>{try{return BigInt(x??0).toLocaleString("en-US");}catch{return "—";}};
const duration=x=>{if(x==null||!Number.isFinite(Number(x)))return "—";const s=Math.max(0,Math.floor(x));return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,"0")).join(":");};
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab,.panel").forEach(x=>x.classList.remove("active"));b.classList.add("active");$("#"+b.dataset.tab).classList.add("active");});
const yesterday=new Date(Date.now()+19800000-864e5).toISOString().slice(0,10),monthAgo=new Date(Date.now()+19800000-25*864e5).toISOString().slice(0,10);
const marketFields=[
 ["symbol","Symbol","select",["NIFTY","BANKNIFTY"],"NIFTY"],
 ["startDate","Start Date","date",null,monthAgo],["endDate","End Date","date",null,yesterday],
 ["resolution","Strategy Resolution","fixed","1 Minute","1"],
 ["executionResolution","Execution Data","fixed","5 Second Spot","5S"],
 ["expiryType","Expiry Type","fixed","Weekly","WEEKLY"],
 ["startingCapital","Starting Capital ₹","number",null,100000],["lots","Lots","number",null,1],
 ["optionResolution","Option Premium Resolution","select",[["1","1 Minute"],["5S","5 Seconds"]],"1"]
];
const strategyFields=[
 ["emaLength","EMA Length","number",null,100],["slopeLookback","Slope Lookback","number",null,10],
 ["entryValidCandles","Entry Valid Candles","number",null,2],["rr","RR","number",null,5],
 ["maxConsecutiveLosses","Max Consecutive Losses / Day","number",null,10],
 ["minStopLossDistancePct","Minimum Stop-Loss Distance %","number",null,0]
];
const rangeGroups=[
 ["EMA",[["emaMin","EMA Min","number",null,5],["emaMax","EMA Max","number",null,300],["emaStep","EMA Step","number",null,1]]],
 ["Slope",[["slopeMin","Slope Min","number",null,1],["slopeMax","Slope Max","number",null,50],["slopeStep","Slope Step","number",null,1]]],
 ["Entry Validity",[["validMin","Entry Valid Min","number",null,1],["validMax","Entry Valid Max","number",null,20]],"Integer increment: 1"],
 ["Risk / Reward",[["rrMin","RR Min","number",null,1],["rrMax","RR Max","number",null,10],["rrStep","RR Step","number",null,.5]]],
 ["Daily Guard",[["lossMin","Max Losses/Day Min","number",null,1],["lossMax","Max Losses/Day Max","number",null,20]],"Integer increment: 1"],
 ["Minimum Stop-Loss Distance",[["stopDistanceMin","Minimum Stop-Loss Distance Min %","number",null,0],["stopDistanceMax","Minimum Stop-Loss Distance Max %","number",null,0],["stopDistanceStep","Minimum Stop-Loss Distance Step %","number",null,.1]],"Signal candle range as a percentage of signal high (BUY) or low (SELL). Default 0 disables this filter."]
];
const base=[...marketFields,...strategyFields],ranges=rangeGroups.flatMap(g=>g[1]);
const optBase=marketFields;
const modeFields=[["mode","Optimisation Mode","select",[["FAST","FAST — Non-exhaustive"],["EXHAUSTIVE","EXHAUSTIVE — Every combination"]],"FAST"]];
function fieldsMarkup(defs,prefix){
 return defs.map(([key,label,type,options,value])=>{
  const id=prefix+key;
  const nonNegative=key.startsWith("rr")||key==="startingCapital"||key.startsWith("stopDistance")||key==="minStopLossDistancePct";
  const control=type==="fixed"?`<input id="${id}" name="${key}" type="hidden" value="${escapeHtml(value)}"><output class="fixed-value" aria-label="${escapeHtml(label)}">${escapeHtml(options)} <small>FIXED</small></output>`:type==="select"?`<select id="${id}" name="${key}" required>${options.map(option=>{const [v,l]=Array.isArray(option)?option:[option,option];return `<option value="${escapeHtml(v)}"${String(v)===String(value)?" selected":""}>${escapeHtml(l)}</option>`;}).join("")}</select>`:
   `<input id="${id}" name="${key}" type="${type}" value="${escapeHtml(value)}" required ${type==="number"?`min="${nonNegative?"0":"1"}" step="${nonNegative?"any":"1"}"`:""}>`;
  return `<div class="field"><label for="${id}">${escapeHtml(label)}</label>${control}</div>`;
 }).join("");
}
function groupMarkup(title,defs,prefix,note=""){return `<fieldset class="field-group"><legend>${escapeHtml(title)}</legend><div class="grid">${fieldsMarkup(defs,prefix)}</div>${note?`<p class="help-text">${escapeHtml(note)}</p>`:""}</fieldset>`;}
$("#backFields").innerHTML=groupMarkup("Market",marketFields,"b_")+groupMarkup("Strategy",strategyFields,"b_");
$("#optFields").innerHTML=groupMarkup("Market",optBase,"o_")+`<div class="range-groups">${rangeGroups.map(([name,defs,note])=>groupMarkup(name,defs,"o_",note)).join("")}</div>`;
$("#modeFields").innerHTML=fieldsMarkup(modeFields,"o_");
function data(defs,prefix){return Object.fromEntries(defs.map(([key])=>[key,$("#"+prefix+key).value]));}
function summary(s){return `<div class="cards">${Object.entries(s).map(([k,v])=>`<div class="card">${escapeHtml(k)}<b>${escapeHtml(typeof v==="number"?Number(v.toFixed(2)):v)}</b></div>`).join("")}</div>`;}
function marketSummary(m,pipeline={},title="MARKET DATA READY"){const r=m?.historyRequests??{};const rows=m?[["Requested Backtest Range",`${m.backtestStart} → ${m.backtestEnd}`],["Strategy Resolution","1 Minute — fixed"],["Execution Data","5 Second Spot — fixed"],["Expiry Type","Weekly — fixed"],["1m Spot Candles",m.strategyCandles],["5S Spot Candles",m.executionCandles],["Trading Days",m.tradingDays],["Resolved Weekly Expiries",m.resolvedExpiries],["Weekly Expiry Dates Discovered",m.weeklyExpiryDatesDiscovered],["Unique Option Contract Symbols",m.uniqueOptionContracts??m.requiredOptionContracts],["ATM Contract Selection Entries",m.optionContractSelectionEntries],["Option Premium Histories Loaded",m.optionPremiumHistoriesLoaded],["Option Premium Candles",m.optionPremiumCandles],["Network Requests",r.networkHistoryRequests??0],["Cache Hits",r.cacheHits??0],["In-flight Deduplicated",r.inFlightDeduplications??0],["1m Requests",r.oneMinuteRequests??0],["5S Requests",r.execution5sRequests??0],["Expiry Requests",r.expiryRequests??0],["Option History Requests",r.optionHistoryRequests??0],["429 Responses",r.rateLimitResponses??0],["Retries",r.retries??0]]:[];
 const pipelineRows=[["Eligible 1m Candles",pipeline.eligible1mCandles],["BUY A Signals",pipeline.buyASignals],["BUY B Signals",pipeline.buyBSignals],["SELL A Signals",pipeline.sellASignals],["SELL B Signals",pipeline.sellBSignals],["Signals Passing Min SL Distance",pipeline.signalsPassingMinStopDistance],["Pending Setups",pipeline.pendingSetups],["Breakouts Triggered",pipeline.breakoutsTriggered],["Entries Requiring Options",pipeline.entriesRequiringOptions],["Option Contracts Resolved",pipeline.optionContractsResolved],["Option Premium Histories Loaded",pipeline.optionPremiumHistoriesLoaded],["Trades Executed",pipeline.tradesExecuted]].filter(([,v])=>v!==undefined);
 rows.push(...pipelineRows);const traces=m?.expiryDiagnostics?.length?`<details><summary>Safe expiry request diagnostics (${m.expiryDiagnostics.length})</summary><pre>${escapeHtml(JSON.stringify(m.expiryDiagnostics,null,2))}</pre></details>`:"";
 return `<div class="progress-panel"><h3>${escapeHtml(title)}</h3><dl>${rows.map(([k,v])=>`<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v??0)}</dd></div>`).join("")}</dl>${traces}</div>`;}
const tradeTimestampColumns=new Set(["Signal Timestamp","Entry Timestamp","Exit Timestamp","signalTimestamp","entryTimestamp","exitTimestamp","signalTime","entryTime","exitTime"]);
const tradeTimestampFormatter=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",hour12:true});
function formatTradeTimestamp(value){
 if(typeof value!=="string"||!value.trim())return value;
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return value;
 const parts=Object.fromEntries(tradeTimestampFormatter.formatToParts(date).map(({type,value})=>[type,value]));
 return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}
function table(el,rows){if(!rows.length){el.innerHTML="<tr><td>No rows</td></tr>";return;}const ks=Object.keys(rows[0]).filter(k=>rows[0][k]===null||typeof rows[0][k]!=="object");el.innerHTML=`<thead><tr>${ks.map(k=>`<th>${escapeHtml(k)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${ks.map(k=>`<td>${escapeHtml(tradeTimestampColumns.has(k)?formatTradeTimestamp(r[k]):r[k])}</td>`).join("")}</tr>`).join("")}</tbody>`;}
function pagedTable(el,rows){
 let page=0;const controls=document.createElement("div");controls.className="actions";el.parentElement.before(controls);if(el._controls)el._controls.remove();el._controls=controls;
 const draw=()=>{table(el,rows.slice(page*100,(page+1)*100));controls.replaceChildren();const prev=document.createElement("button"),next=document.createElement("button"),label=document.createElement("span");prev.type=next.type="button";prev.textContent="Previous";next.textContent="Next";prev.disabled=page===0;next.disabled=(page+1)*100>=rows.length;label.textContent=` Page ${page+1} / ${Math.max(1,Math.ceil(rows.length/100))} · ${rows.length} rows `;prev.onclick=()=>{page--;draw();};next.onclick=()=>{page++;draw();};controls.append(prev,label,next);};draw();
}
async function refreshAuthStatus(){
 try{const status=await get("/api/status");$("#authStatus").textContent=status.connected?"● FYERS Connected":"● FYERS Not Connected";$("#authStatus").className=status.connected?"good":"bad";$("#connectFyers").hidden=!!status.connected;}
 catch{$("#authStatus").textContent="● FYERS Not Connected";$("#authStatus").className="bad";$("#connectFyers").hidden=false;}
}
function workflowProgressMarkup({workflow="BACKTEST",status="preparing_data",message="",progress=null,wait=null,error="",complete=false,elapsed=null,mode=null,evaluated=0,requested=null,fastStage=null}={}){
 const failed=["failed","incomplete"].includes(status),cancelled=status==="cancelled",done=complete||status==="complete",all=progress?.stages??{},preparing=progress?.preparationStages??{},rows=workflow==="BACKTEST"?
  [["strategy_spot","1 Minute Spot"],["execution_spot","5 Second Spot"],["weekly_expiries","Weekly Expiries"],["option_contracts","Option Contracts"],["option_premiums","Option Premiums"],["running_backtest","Running Backtest"],["complete","Complete"]]:
  [["strategy_spot","1 Minute Spot"],["execution_spot","5 Second Spot"],["weekly_expiries","Weekly Expiries"],["option_contracts","Required Option Contracts"],["option_premiums","Required Option Premiums"],["preparing_optimisation","Preparing Optimisation"],["evaluating_candidates","Evaluating Candidates"],["finalise","Finalising Best Result"],["complete","Complete"]];
 const evalStage=progress?.evaluationProgress,finalStage=progress?.finalisingProgress;
 const stageItem=id=>(id==="evaluating_candidates"?evalStage:id==="finalise"?finalStage:id==="complete"?(done?{status:"complete",completed:1,total:1,unit:"workflow"}:{}):(all[id]??preparing[id]))??{};
 const active=progress?.activeStage??progress?.activePreparationStage;
 const stageText=rows.map(([id,name])=>{
  const item=stageItem(id),isActive=id===active||id==="evaluating_candidates"&&status==="running"||id==="finalise"&&status==="sorting"||id==="running_backtest"&&item.status==="processing";
  const stageFailed=failed&&isActive||item.status==="failed",stageDone=done||item.status==="complete";
  const state=stageFailed?"✕ Failed":cancelled&&isActive?"● Cancelled":stageDone?"✓ Complete":item.status==="waiting_rate_limit"?`● Waiting before retry${Number(item.retry)>0?` — next retry ${item.retry}/${item.maxRetries}`:item.phase==="initial_request"?" — first request pending":""}`:item.status==="retrying"?`● Retrying — ${item.retry}/${item.maxRetries}`:item.status==="waiting_pacing"?"● Waiting for request interval":item.status==="fetching"?"● Fetching...":item.status==="resolving"?"● Resolving...":item.status==="processing"?"● Processing...":item.status==="waiting"||!item.status?"○ Waiting":"● Preparing...";
  const cls=stageFailed?"failed":stageDone?"complete":isActive?"active":"waiting",units=item.work??{};let primary;
  if(item.completed!==undefined||item.total!==undefined)primary=item;
  else primary=units[id==="weekly_expiries"?"sessions":id==="option_contracts"?(units.contracts?.total!=null?"contracts":units["expiry catalogs"]?"expiry catalogs":"contracts"):id==="option_premiums"?"histories":id==="evaluating_candidates"?"candidates":id==="preparing_optimisation"?"EMA/slope pairs":"chunks"];
  let pct=primary?.percentage??(primary?.total>0?Math.floor(primary.completed/primary.total*100):null);if(stageDone&&primary?.total===0)pct=100;
  const unitName=primary?.unit??Object.values(units).find(x=>x===primary)?.unit??(id==="strategy_spot"||id==="execution_spot"?"chunks":id==="weekly_expiries"?"sessions":id==="option_contracts"?"contracts":id==="option_premiums"?"histories":"units");let detail=primary?(pct===null?`${formatCount(primary.completed??0)} ${unitName} completed${primary.total==null?" — total not yet known":` / ${formatCount(primary.total)}`}`:`${pct}% — ${formatCount(primary.completed)} / ${formatCount(primary.total)} ${unitName}`):"";
  if(id==="option_contracts"&&units.contracts?.completed>0&&units.contracts.total==null)detail+=`${detail?" · ":""}${formatCount(units.contracts.completed)} ATM contracts resolved — total not yet known`;
  const activity=item.activity&&isActive?`<small>${escapeHtml(item.activity)}</small>`:"";
  return `<li class="prep-stage prep-stage-${cls}"><span>${escapeHtml(name)}${activity}</span><div class="prep-stage-result"><b>${state}</b>${detail?`<small>${escapeHtml(detail)}</small>`:""}</div></li>`;
 }).join("");
 const overall=done?100:null,elapsedText=elapsed==null?"":`<p class="prep-elapsed">Elapsed: ${duration(elapsed)}</p>`;
 let activity=failed?"":progress?.currentActivity??progress?.message??message;
 if(status==="waiting_rate_limit")activity=`Waiting before retry${wait?.retry>0?` — Next retry ${wait.retry}/${wait.maxRetries}`:""}${wait?` — ${Math.ceil(wait.waitMs/1000)}s cooldown`:""}. ${activity}`;
 else if(status==="queued")activity="Queued — waiting to prepare market data.";
 if(workflow==="OPTIMISATION"&&status==="sorting")activity="Finalising best optimisation result";
 else if(workflow==="OPTIMISATION"&&status==="running")activity=mode==="FAST"?`Evaluating FAST optimisation — ${fastStage??progress?.stage??"search"}`:`Evaluating EXHAUSTIVE optimisation — ${formatCount(evaluated)} / ${formatCount(requested)} combinations`;
 const title=failed?workflow==="BACKTEST"?"BACKTEST FAILED — MARKET DATA PREPARATION FAILED":`${workflow} FAILED`:cancelled?`${workflow} CANCELLED`:done?workflow==="BACKTEST"?"BACKTEST COMPLETE — MARKET DATA READY":"OPTIMISATION COMPLETE":workflow==="OPTIMISATION"?"OPTIMISATION PROGRESS":"BACKTEST PROGRESS";
 const label=done?"100%":"Indeterminate",barLabel=`Overall ${workflow.toLowerCase()} progress`;
 return `<section class="prep-progress ${failed?"is-failed":done?"is-complete":cancelled?"is-cancelled":"is-active"}" aria-label="${barLabel}" aria-live="polite"><h3>${title}</h3>${workflow==="OPTIMISATION"?`<p class="prep-mode">Mode: ${mode??"—"}${mode==="FAST"?" — Non-exhaustive":mode==="EXHAUSTIVE"?" — Every combination":""}</p>`:""}<div class="prep-overall-label">Overall Progress <b>${label}</b></div><div class="prep-progress-track" role="progressbar" aria-label="${barLabel}" aria-valuemin="0" ${done?'aria-valuemax="100" aria-valuenow="100"':'aria-valuetext="Working — overall total work is not yet measurable."'}><span class="prep-progress-fill ${done?"determinate":"indeterminate"}" ${done?'style="width:100%"':""}></span></div>${!done?'<div class="prep-progress-caption">Overall total work is not yet measurable.</div>':""}${activity?`<p class="prep-activity">${escapeHtml(activity)}</p>`:""}${elapsedText}<ul class="prep-stages">${stageText}</ul>${workflow==="OPTIMISATION"?`<p class="prep-candidate-count">${mode==="FAST"?`FAST candidates evaluated: ${formatCount(evaluated)} (non-exhaustive)`: `Evaluated: ${formatCount(evaluated)} / ${formatCount(requested)}`}</p>`:""}${error?`<pre class="prep-error">${escapeHtml(error)}</pre>`:""}</section>`;
}
function backPreparationMarkup(options={}){return workflowProgressMarkup({workflow:"BACKTEST",...options});}
async function runBacktest(context={}){
 if($("#backForm").reportValidity&&!$("#backForm").reportValidity())return;
 const st=$("#backStatus");let lastBackProgress=null;$("#runBack").disabled=true;st.innerHTML=backPreparationMarkup({message:`Backtest: ${$("#b_startDate").value} → ${$("#b_endDate").value}. Preparing historical market data.`,elapsed:0});$("#summary").innerHTML="";$("#trades").innerHTML="";$("#skipped").textContent="";
 const waitPoll=setInterval(async()=>{try{const status=await get("/api/status"),progress=status.marketDataProgress;if(progress){lastBackProgress=progress;st.innerHTML=backPreparationMarkup({status:progress.status,message:progress.message,progress,wait:status.marketDataWait,elapsed:progress.elapsed});}}catch{}},300);
 try{
  const input=data(base,"b_");if(context.emaSeedDate)input.emaSeedDate=context.emaSeedDate;
  const result=await post("/api/backtest",input);$("#summary").innerHTML=marketSummary(result.marketData,result.pipelineCounters)+summary(result.summary);pagedTable($("#trades"),result.trades);$("#skipped").textContent=JSON.stringify(result.skipped,null,2);
  st.innerHTML=result.summary.incompleteData?backPreparationMarkup({status:"failed",message:"Backtest completed with unavailable trades.",error:"Finished with unavailable trades — results are incomplete."}):backPreparationMarkup({complete:true,message:"Market data preparation completed successfully."});return result;
 }catch(e){if(e.response?.incompleteData)$("#summary").innerHTML=marketSummary(e.response.marketData,e.response.pipelineCounters,"MARKET DATA INCOMPLETE");const error=e.message.includes("BACKTEST NOT RUN")?e.message:`BACKTEST NOT RUN\n${e.message}`;st.innerHTML=backPreparationMarkup({status:"failed",message:error,error,progress:lastBackProgress,elapsed:lastBackProgress?.elapsed});}finally{clearInterval(waitPoll);$("#runBack").disabled=false;void refreshAuthStatus();}
}
$("#runBack").onclick=()=>runBacktest();
$("#backForm").onsubmit=e=>{e.preventDefault();void runBacktest();};
async function applyBest(result){
 const best=result.bestResult??result.best;
 if(!best)return;
 const contextKeys=["symbol","startDate","endDate","startingCapital","lots","optionResolution"];
 if(contextKeys.some(key=>String($("#b_"+key).value)!==String(result.config[key]))){
  $("#optStatus").textContent="Backtesting inputs differ from the market context used by this result. Set them to the optimisation run's displayed inputs, then apply again. No dates or fixed settings were changed.";return;
 }
 for(const key of ["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses","minStopLossDistancePct"])$("#b_"+key).value=String(best[key]??0);
 document.querySelector('[data-tab="back"]').click();
 const detailed=await runBacktest({emaSeedDate:result.config.emaSeedDate});
 const expected=best.returnPct??best.totalReturnPct;
 if(detailed&&Number.isFinite(expected)&&Math.abs(detailed.summary.totalReturnPct-expected)>1e-9*Math.max(1,Math.abs(expected)))$("#backStatus").textContent="Backtest finished, but its return differs from the evaluated candidate. Check the displayed data availability and snapshot; this is a consistency error.";
}
function bestTitle(result){
 if(["cancelled","incomplete","failed"].includes(result.status))return "BEST RESULT FOUND BEFORE INTERRUPTION";
 if(result.mode==="FAST")return "BEST RESULT FOUND — FAST MODE";
 if(result.status==="complete"&&result.exhaustive&&String(result.evaluated)===String(result.requested)&&!result.unavailableCandidates)return "BEST POSSIBLE RESULT — EXHAUSTIVE SEARCH";
 return result.unavailableCandidates?"BEST RESULT FOUND — SOME CANDIDATES UNAVAILABLE":"BEST RESULT SO FAR";
}
function renderBest(result){
 const best=result.bestResult??result.best;if(!best){$("#best").innerHTML="";return;}
 const pc=best.pipelineCounters??{},counterKeys=[["Eligible 1m Candles","eligible1mCandles"],["BUY A Signals","buyASignals"],["BUY B Signals","buyBSignals"],["SELL A Signals","sellASignals"],["SELL B Signals","sellBSignals"],["Signals Passing Min SL Distance","signalsPassingMinStopDistance"],["Pending Setups","pendingSetups"],["Breakouts Triggered","breakoutsTriggered"],["Entries Requiring Options","entriesRequiringOptions"],["Weekly Expiries Resolved","weeklyExpiriesResolved"],["Option Contracts Resolved","optionContractsResolved"],["Option Premium Histories Loaded","optionPremiumHistoriesLoaded"],["Trades Executed","tradesExecuted"]];
 const values=[["Best EMA Length",best.emaLength],["Best Slope Lookback",best.slopeLookback],["Best Entry Valid Candles",best.entryValidCandles],["Best RR",`1:${best.rr}`],["Best Max Consecutive Losses / Day",best.maxConsecutiveLossesPerDay??best.maxConsecutiveLosses],["Minimum Stop-Loss Distance %",best.minStopLossDistancePct??0],["Expiry Type","Weekly"],["Strategy Resolution","1 Minute"],...(result.mode==="FAST"?[["Total Parameter Space",formatCount(result.requested)],["Candidates Actually Evaluated",formatCount(result.evaluated)]]:[["Evaluated / Requested",`${formatCount(result.evaluated)} / ${formatCount(result.requested)}`]]),...counterKeys.filter(([,key])=>pc[key]!==undefined).map(([label,key])=>[label,pc[key]]),["Search Type",result.mode==="FAST"?"FAST — Non-exhaustive":result.exhaustive?"Exhaustive — completed":"Exhaustive — incomplete"]];
 const terminal=!["queued","preparing","preparing_data","waiting_rate_limit","running","sorting"].includes(result.status);
 $("#best").innerHTML=`<article class="best-card"><h3>${escapeHtml(bestTitle(result))}</h3><div class="best-return ${best.returnPct>=0?"good":"bad"}">${escapeHtml(formatReturn(best.returnPct??best.totalReturnPct))}</div><div class="return-label">RETURN</div><dl>${values.map(([k,v])=>`<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>${terminal?'<button type="button" id="apply">Apply Best to Backtesting</button>':""}</article>`;
 if(terminal)$("#apply").onclick=async()=>{$("#apply").disabled=true;try{await applyBest(result);}finally{$("#apply").disabled=false;}};
}
function renderProgress(result){
 const best=result.bestResult??result.best;
 const finishedFast=result.mode==="FAST"&&result.status==="complete"&&Number(result.evaluated??result.processed??0)>0&&!!best;
 const label=result.status==="queued"?"OPTIMISATION QUEUED":result.status==="preparing"||result.status==="preparing_data"?"OPTIMISATION PREPARING DATA":result.status==="waiting_rate_limit"?"PREPARING MARKET DATA — WAITING FOR FYERS RATE LIMIT":result.status==="cancelled"?"OPTIMISATION CANCELLED":result.status==="failed"?"OPTIMISATION FAILED":result.status==="incomplete"?"OPTIMISATION INCOMPLETE":result.mode==="FAST"?(result.status==="running"||result.status==="sorting"?"FAST OPTIMISATION RUNNING":finishedFast?"FAST OPTIMISATION COMPLETE":"FAST OPTIMISATION FAILED — NO RESULT"):result.status==="complete"?"EXHAUSTIVE OPTIMISATION COMPLETE":"OPTIMISATION RUNNING";
 const countMetrics=result.mode==="FAST"?[["Total Parameter Space",formatCount(result.requested)],["FAST Candidates Evaluated",formatCount(result.evaluated)]]:[["Evaluated / Requested",`${formatCount(result.evaluated)} / ${formatCount(result.requested)}`]];
 const metrics=[["Backtest Range",result.config?.startDate&&result.config?.endDate?`${result.config.startDate} → ${result.config.endDate}`:"—"],["Strategy Resolution",result.config?.resolution?resolutionLabel(result.config.resolution):"—"],["Stage",result.stage??"Queued"],...countMetrics,["Stored / Displayable Results",formatCount(result.storedResults)],["Elapsed",duration(result.elapsed)],["Best Return So Far",best?formatReturn(best.returnPct??best.totalReturnPct):"—"]];
 if(result.marketData)metrics.push(["Strategy Candles",formatCount(result.marketData.strategyCandles)],["5S Spot Candles",formatCount(result.marketData.executionCandles)],["Trading Days",formatCount(result.marketData.tradingDays)],["Resolved Expiries",formatCount(result.marketData.resolvedExpiries)],["Required Option Contracts",formatCount(result.marketData.requiredOptionContracts)],["Option Premium Candles",formatCount(result.marketData.optionPremiumCandles)]);
 const requests=result.historyRequests??result.marketData?.historyRequests;if(requests)metrics.push(["Network Requests",formatCount(requests.networkHistoryRequests)],["Cache Hits",formatCount(requests.cacheHits)],["In-flight Deduplicated",formatCount(requests.inFlightDeduplications)],["1m Requests",formatCount(requests.oneMinuteRequests)],["5S Requests",formatCount(requests.execution5sRequests)],["Expiry Requests",formatCount(requests.expiryRequests)],["Option History Requests",formatCount(requests.optionHistoryRequests)],["429 Responses",formatCount(requests.rateLimitResponses)],["Retries",formatCount(requests.retries)],["Cooldown Remaining",`${formatCount(requests.cooldownRemainingMs)} ms`]);
 if(result.mode==="EXHAUSTIVE")metrics.push(["Progress",`${Number(result.progressPct??0).toFixed(4)}%`],["Estimated Remaining",duration(result.estimatedRemaining)]);
 if(best)metrics.push(["Best EMA",best.emaLength],["Best Slope",best.slopeLookback],["Best Entry Valid",best.entryValidCandles],["Best RR",`1:${best.rr}`],["Best Max Losses/Day",best.maxConsecutiveLosses],["Minimum Stop-Loss Distance %",best.minStopLossDistancePct??0],["Expiry","Weekly"]);
 const config=result.config??{},isDone=result.status==="complete",isFailed=["failed","incomplete"].includes(result.status),isCancelled=result.status==="cancelled";
 const progress=workflowProgressMarkup({workflow:"OPTIMISATION",status:result.status,progress:result,message:result.message??result.reason,elapsed:result.elapsed,mode:result.mode,evaluated:result.evaluated??result.processed??0,requested:result.requested,fastStage:result.stage,complete:isDone,error:isFailed||isCancelled?result.reason??"": ""});
 const details=`<div class="progress-panel"><h3>${escapeHtml(label)}</h3><dl>${metrics.map(([k,v])=>`<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>${result.reason?`<p>${escapeHtml(result.reason)}</p>`:""}</div>`;
 $("#optStatus").innerHTML=progress+details;
 $("#retentionInfo").textContent=result.retentionLimited?`Retention is bounded: ${formatCount(result.storedResults)} rows are displayable out of ${formatCount(result.evaluated)} evaluated. The best result is retained; omitted rows did not stop evaluation. ${result.retentionWarning??""}`:"";
 renderBest(result);
}
function requestedCount(){
 const x=data([...optBase,...ranges],"o_"),groups=[["emaMin","emaMax","emaStep"],["slopeMin","slopeMax","slopeStep"],["validMin","validMax"],["rrMin","rrMax","rrStep"],["lossMin","lossMax"]];
 groups.push(["stopDistanceMin","stopDistanceMax","stopDistanceStep"]);
 return groups.reduce((total,[min,max,step])=>{const a=Number(x[min]),b=Number(x[max]),s=step?Number(x[step]):1;if(![a,b,s].every(Number.isFinite)||a<(min==="stopDistanceMin"?0:1)||b<a||s<=0)throw new Error("Invalid range");return total*BigInt(Math.floor((b-a)/s+1e-8)+1);},1n);
}
function updateSearchDescription(){
 const exhaustive=$("#o_mode").value==="EXHAUSTIVE";
 $("#searchDescription").textContent=exhaustive?"EXHAUSTIVE evaluates every requested combination. Cancellation or a runtime/resource limit leaves the search incomplete.":"FAST uses a deterministic coarse search followed by refinement. It finds the best candidate evaluated, without a global-optimum guarantee.";
 try{const count=requestedCount();$("#searchWarning").hidden=!exhaustive;$("#searchWarning").textContent=exhaustive?`This search requests ${formatCount(count)} combinations.${count>=1000000n?" It may take many hours or longer.":""} Result retention is bounded; reaching the storage budget will not stop evaluation. Mode will not switch automatically.`:"";}catch{$("#searchWarning").hidden=true;}
}
$("#optForm").oninput=updateSearchDescription;$("#o_mode").onchange=updateSearchDescription;
let activeJob=null,resultPage=0;
async function loadResultPage(page){const result=await get(`/api/optimise/${activeJob}/results?page=${page}`);resultPage=page;table($("#results"),result.rows);$("#resultPage").textContent=` Page ${page+1} / ${Math.max(1,Math.ceil(result.totalRows/100))} · ${result.totalRows} stored rows `;$("#prevResults").disabled=page===0;$("#nextResults").disabled=(page+1)*100>=result.totalRows;}
$("#prevResults").onclick=()=>loadResultPage(Math.max(0,resultPage-1)).catch(e=>$("#optStatus").textContent=e.message);
$("#nextResults").onclick=()=>loadResultPage(resultPage+1).catch(e=>$("#optStatus").textContent=e.message);
$("#cancelOpt").onclick=async()=>{if(!activeJob)return;try{$("#cancelOpt").disabled=true;await post(`/api/optimise/${activeJob}/cancel`,{});$("#cancelOpt").textContent="Cancellation requested";}catch(e){$("#optStatus").textContent=e.message;$("#cancelOpt").disabled=false;}};
async function runOptimisation(){
 if($("#optForm").reportValidity&&!$("#optForm").reportValidity())return;
 const input=data([...optBase,...ranges,...modeFields],"o_");
 let requested;try{requested=requestedCount().toString();}catch(e){$("#optStatus").textContent=e.message;return;}
 $("#runOpt").disabled=true;$("#cancelOpt").textContent="Cancel Optimisation";$("#best").innerHTML="";$("#resultControls").hidden=true;table($("#results"),[]);
 renderProgress({status:"preparing_data",mode:input.mode,stage:"Preparing Market Data",config:input,evaluated:0,requested,storedResults:0,elapsed:0});
 // The optimization market inputs are authoritative for the run; synchronize
 // the detailed Backtest form now, while Apply Best itself changes only strategy
 // parameters. Dates are never changed during Apply Best.
 for(const key of ["symbol","startDate","endDate","startingCapital","lots","optionResolution"])$("#b_"+key).value=input[key];
 document.querySelectorAll("#optForm input,#optForm select").forEach(el=>el.disabled=true);
 try{
  const job=await post("/api/optimise",input);activeJob=job.jobId??job.id;
  renderProgress({status:"queued",mode:input.mode,stage:"Queued",config:input,evaluated:0,requested:job.requested??requested,storedResults:0,elapsed:0});
  $("#cancelOpt").disabled=false;
  let result;
  do{result=await get(`/api/optimise/${activeJob}`);renderProgress(result);if(["queued","preparing","preparing_data","waiting_rate_limit","running","sorting"].includes(result.status))await new Promise(resolve=>setTimeout(resolve,250));else break;}while(true);
  if(result.exportAvailable){$("#resultControls").hidden=false;$("#exportResults").href=`/api/optimise/${activeJob}/export`;await loadResultPage(0);}
  if(!result.bestResult&&result.status==="complete")$("#best").textContent="No eligible best result is available. Check the unavailable-candidate counts and retained result reasons.";
 }catch(e){$("#optStatus").textContent=e.message;}finally{$("#runOpt").disabled=false;$("#cancelOpt").disabled=true;document.querySelectorAll("#optForm input,#optForm select").forEach(el=>el.disabled=false);void refreshAuthStatus();}
}
$("#runOpt").onclick=runOptimisation;$("#optForm").onsubmit=e=>{e.preventDefault();void runOptimisation();};
async function get(url){const response=await fetch(url,{cache:"no-store"});const body=await response.json();if(!response.ok)throw new Error(body.error||"Request failed");return body;}
async function post(url,body){const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const json=await response.json();if(!response.ok){const error=new Error(json.error||"Request failed");error.response=json;throw error;}return json;}
if(new URLSearchParams(location.search).get("auth")==="failed"){$("#authError").hidden=false;$("#authError").textContent="FYERS connection was not completed. Use Connect FYERS to try again and check the server-side callback configuration.";}
updateSearchDescription();void refreshAuthStatus();
if(typeof window!=="undefined"){window.addEventListener("pageshow",refreshAuthStatus);window.addEventListener("focus",refreshAuthStatus);}

// Separate spot-only workflows. These controls and routes never touch the
// existing ATM-options Backtesting/Optimisation forms.
const spotMarket=[...marketFields.slice(0,3),["resolution","Strategy Resolution","fixed","1 Minute","1"]];
const spotStrategy=[...strategyFields];
const spotRanges=[
 ["EMA",[["emaMin","EMA Min","number",null,5],...[ ["emaMax","EMA Max","number",null,300],["emaStep","EMA Step","number",null,1] ]]],
 ["Slope",[["slopeMin","Slope Min","number",null,1],["slopeMax","Slope Max","number",null,50],["slopeStep","Slope Step","number",null,1]]],
 ["Entry Validity",[["validMin","Entry Valid Min","number",null,1],["validMax","Entry Valid Max","number",null,20]],"Integer increment: 1"],
 ["Risk / Reward",[["rrMin","RR Min","number",null,1],["rrMax","RR Max","number",null,10],["rrStep","RR Step","number",null,.5]]],
 ["Daily Guard",[["lossMin","Max Losses/Day Min","number",null,1],["lossMax","Max Losses/Day Max","number",null,20]],"Integer increment: 1"],
 ["Minimum Stop-Loss Distance",[["stopDistanceMin","Min %","number",null,0],["stopDistanceMax","Max %","number",null,.50],["stopDistanceStep","Step %","number",null,.05]],"0 disables the filter. Decimal values below 1 are supported."]
];
const spotRangeFields=spotRanges.flatMap(g=>g[1]);
$("#spotBackFields").innerHTML=groupMarkup("Market",spotMarket,"sb_")+groupMarkup("Strategy",spotStrategy,"sb_");
$("#spotOptFields").innerHTML=groupMarkup("Market",spotMarket,"so_")+`<div class="range-groups">${spotRanges.map(([name,defs,note])=>groupMarkup(name,defs,"so_",note)).join("")}</div>`;
const spotBaseInput=(prefix)=>({...data(spotMarket,prefix),...(prefix==="sb_"?data(spotStrategy,prefix):{})});
const spotTerminal=["complete","failed","cancelled","incomplete"];
const spotStageLabels={fetching_spot:"Fetching 1-Minute Spot Data",preparing_market_data:"Preparing Market Data",preparing_indicators:"Preparing Indicators",finding_signals:"Finding Signals",running_backtest:"Running Backtest",finalising_statistics:"Finalising Statistics",preparing_optimisation:"Preparing Optimisation",evaluating_candidates:"Evaluating Candidates",finalising_best_result:"Finalising Best Result",complete:"Complete"};
function spotProgressMarkup(state,optimization=false){
 const p={...(state.progress??{})},evaluation=state.evaluationProgress,active=state.stage;if(state.preparationProgress)p[state.preparationProgress.stage]=state.preparationProgress;if(evaluation)p.evaluating_candidates=evaluation;
 const title=optimization?"1-MINUTE OPTIMISATION PROGRESS":"1-MINUTE BACKTEST PROGRESS";
 let current=state.currentActivity??state.reason??"Preparing 1-minute spot data...",meter="";
 if(optimization){const total=evaluation?.total,completed=evaluation?.completed??state.evaluated??0;current=state.currentActivity??`${state.stage??"Preparing market data"}`;meter=total!=null?`<p class="spot-meter">Candidates: ${formatCount(completed)} / ${formatCount(total)}${state.mode==="EXHAUSTIVE"?` — ${Number((completed/Math.max(1,total))*100).toFixed(2)}%`:""}</p>`:`<p class="spot-meter">${state.mode==="FAST"?"FAST — Non-exhaustive":""} · candidate total not measurable for this refinement stage</p>`;}
 const stages=optimization?["fetching_spot","preparing_market_data","preparing_optimisation","evaluating_candidates","finalising_best_result","complete"]:["fetching_spot","preparing_indicators","finding_signals","running_backtest","finalising_statistics","complete"];
 const details=stages.map(key=>{const item=p[key]??(key==="evaluating_candidates"?evaluation:null),isBlocked=item?.status==="blocked"||spotTerminal.includes(state.status)&&state.status!=="complete"&&!item?.status,isDone=state.status==="complete"||item?.status==="complete",isFailed=state.status==="failed"&&(active===key||item?.status==="failed"),isActive=!spotTerminal.includes(state.status)&&active===key;let label=isBlocked?"NOT RUN / BLOCKED":isFailed?"✕ Failed":isDone?"✓ Complete":isActive?(item?.status==="fetching"?"● Fetching...":item?.status==="processing"?"● Processing...":"● Working..."):"○ Waiting";let d="";if(item?.total>0)d=`${Math.floor((item.completed??0)/item.total*100)}% — ${formatCount(item.completed)} / ${formatCount(item.total)} ${item.unit??"units"}`;else if(isDone)d="100%";return `<li class="prep-stage ${isFailed?"prep-stage-failed":isDone?"prep-stage-complete":isActive?"prep-stage-active":""}"><span>${escapeHtml(spotStageLabels[key]??(key==="evaluating_candidates"?"Evaluating Candidates":key==="finalising_best_result"?"Finalising Best Result":key))}</span><div class="prep-stage-result"><b>${label}</b>${d?`<small>${escapeHtml(d)}</small>`:""}</div></li>`;}).join("");
 const failure=["failed","incomplete","cancelled"].includes(state.status)?`<p class="prep-error">${escapeHtml(state.reason??"Spot backtest failed")}</p>`:"";
 const elapsed=state.elapsed==null?"—":duration(state.elapsed);
 const complete=state.status==="complete",kind=complete?"is-complete":state.status==="failed"?"is-failed":state.status==="cancelled"?"is-cancelled":"",bar=complete?'<div class="prep-overall-label"><span>Overall progress</span><b>100%</b></div><div class="prep-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span class="prep-progress-fill determinate"></span></div>':'<div class="prep-overall-label"><span>Overall progress</span><b>Not yet measurable</b></div><div class="prep-progress-track" role="progressbar" aria-label="Overall progress indeterminate"><span class="prep-progress-fill indeterminate"></span></div>';
 return `<section class="prep-progress ${kind}"><h3>${title}${complete?" — COMPLETE":state.status==="failed"?" — FAILED":state.status==="cancelled"?" — CANCELLED":""}</h3>${bar}<p class="prep-activity">${escapeHtml(current)}</p>${optimization?`<p class="prep-mode">Mode: ${state.mode==="FAST"?"FAST — Non-exhaustive":"EXHAUSTIVE — Every combination"}</p>`:""}${meter}<p class="prep-elapsed">Elapsed: ${elapsed}</p><ul class="prep-stages">${details}</ul>${failure}</section>`;
}
function renderSpotBackResult(result){
 $("#spotBackSummary").innerHTML=summary(Object.fromEntries(Object.entries(result.summary).map(([k,v])=>[k.replace(/[A-Z]/g,m=>` ${m}`).replace(/^./,m=>m.toUpperCase()),typeof v==="number"?Number(v.toFixed(3)):v])));
 table($("#spotTrades"),result.trades.map(t=>({"Trade #":t.tradeNumber,Date:t.date,Direction:t.direction,"Signal Type":t.signalType,"Signal Timestamp":t.signalTimestamp,"Signal Open":t.signalOpen,"Signal High":t.signalHigh,"Signal Low":t.signalLow,"Signal Close":t.signalClose,EMA:t.ema,"EMA Slope":t.emaSlope,"Stop Distance %":t.stopDistancePct,"Entry Timestamp":t.entryTimestamp,"Entry Price":t.entryPrice,SL:t.sl,Target:t.target,RR:t.rr,"Exit Timestamp":t.exitTimestamp,"Exit Price":t.exitPrice,Outcome:t.outcome,"Holding Time (min)":t.holdingMinutes})));
 const d=result.diagnostics?.historyRequests??{};$("#spotBackSummary").insertAdjacentHTML("beforeend",`<div class="progress-panel"><h3>Spot Data Diagnostics</h3><dl>${[["1m Requests",d.oneMinuteRequests??0],["Network Requests",d.networkHistoryRequests??0],["Cache Hits",d.cacheHits??0],["In-flight Deduplications",d.inFlightDeduplications??0],["429 Responses",d.rateLimitResponses??0],["Retries",d.retries??0],["5S Requests",d.execution5sRequests??0],["Expiry Requests",d.expiryRequests??0],["Option History Requests",d.optionHistoryRequests??0],["Warm-up Start",result.diagnostics.emaWarmupStart],["Daily Guard EOD Rule",result.diagnostics.dailyGuardEODBehavior]].map(([k,v])=>`<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl></div>`);
}
let spotBackJob=null,spotOptJob=null,spotOptPage=0;
$("#runSpotBack").onclick=async()=>{
 if(!$("#spotBackForm").reportValidity())return;$("#runSpotBack").disabled=true;$("#cancelSpotBack").disabled=false;$("#spotBackSummary").innerHTML="";table($("#spotTrades"),[]);
 try{const created=await post("/api/spot-backtest",spotBaseInput("sb_"));spotBackJob=created.jobId;while(true){const state=await get(`/api/spot-backtest/${spotBackJob}`);$("#spotBackStatus").innerHTML=spotProgressMarkup(state)+(state.result?"":spotNetworkMarkup(state.historyRequests));if(spotTerminal.includes(state.status)){if(state.result)renderSpotBackResult(state.result);break;}await new Promise(r=>setTimeout(r,250));}}
 catch(e){$("#spotBackStatus").innerHTML=`<p class="prep-error">${escapeHtml(e.message)}</p>`;}finally{$("#runSpotBack").disabled=false;$("#cancelSpotBack").disabled=true;spotBackJob=null;}
};
$("#cancelSpotBack").onclick=async()=>{if(spotBackJob)try{await post(`/api/spot-backtest/${spotBackJob}/cancel`,{});}catch(e){$("#spotBackStatus").textContent=e.message;}};
const spotOptBase=()=>({...data(spotMarket,"so_"),...data(spotRangeFields,"so_"),mode:$("#spotMode").value});
function spotRequestedCount(){const x=spotOptBase(),axes=[["emaMin","emaMax","emaStep"],["slopeMin","slopeMax","slopeStep"],["validMin","validMax"],["rrMin","rrMax","rrStep"],["lossMin","lossMax"],["stopDistanceMin","stopDistanceMax","stopDistanceStep"]];return axes.reduce((p,[a,b,s])=>{const lo=Number(x[a]),hi=Number(x[b]),step=s?Number(x[s]):1;if(![lo,hi,step].every(Number.isFinite)||lo<(a==="stopDistanceMin"?0:1)||hi<lo||step<=0)throw new Error("Invalid optimisation range");return p*BigInt(Math.floor((hi-lo)/step+1e-8)+1);},1n);}
function updateSpotWarning(){try{const n=spotRequestedCount();$("#spotOptWarning").hidden=$("#spotMode").value!=="EXHAUSTIVE";$("#spotOptWarning").textContent=`EXHAUSTIVE will evaluate all ${formatCount(n)} combinations. This may take a long time; cancellation leaves an incomplete search.`;}catch{$("#spotOptWarning").hidden=true;}}
$("#spotOptForm").oninput=updateSpotWarning;$("#spotMode").onchange=updateSpotWarning;
function spotCandidateRows(rows){return rows.map((r,i)=>({Rank:i+1,EMA:r.emaLength,SlopeLookback:r.slopeLookback,EntryValidCandles:r.entryValidCandles,RR:r.rr,MinStopDistancePct:r.minStopLossDistancePct,MaxLossesPerDay:r.maxConsecutiveLosses,Signals:r.signals,Entries:r.entries,TargetHits:r.targetHits,SLHits:r.slHits,EODExits:r.eodExits,WinRatePct:r.winRatePct,TargetHitRatePct:r.targetHitRatePct,ExpectancyR:r.expectancyR,MaxConsecutiveLosses:r.maximumConsecutiveLosses}));}
function spotNetworkMarkup(requestStats={}){
 const rows=[["1m Requests",requestStats.oneMinuteRequests??0],["Network Requests",requestStats.networkHistoryRequests??0],["Cache Hits",requestStats.cacheHits??0],["In-flight Deduplications",requestStats.inFlightDeduplications??0],["429 Responses",requestStats.rateLimitResponses??0],["Retries",requestStats.retries??0],["5S Requests",requestStats.execution5sRequests??0],["Expiry Requests",requestStats.expiryRequests??0],["Option History Requests",requestStats.optionHistoryRequests??0]];
 return `<div class="progress-panel"><h3>Spot Data Request Diagnostics</h3><dl>${rows.map(([k,v])=>`<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl></div>`;
}
function renderSpotOpt(state){
 $("#spotOptStatus").innerHTML=spotProgressMarkup(state,true)+spotNetworkMarkup(state.historyRequests);const best=state.bestResult;
 if(best){const title=state.status==="cancelled"||state.status==="incomplete"||state.status==="failed"?"BEST RESULT FOUND BEFORE INTERRUPTION":state.mode==="FAST"?"BEST RESULT FOUND — FAST MODE":state.status==="complete"&&state.exhaustive&&String(state.evaluated)===String(state.requested)?"BEST POSSIBLE RESULT — EXHAUSTIVE MODE":"BEST RESULT FOUND";
 $("#spotOptBest").innerHTML=`<article class="best-card"><h3>${title}</h3><div class="best-return">${Number(best.expectancyR).toFixed(3)}R</div><div class="return-label">EXPECTANCY</div><dl>${[["EMA Length",best.emaLength],["Slope Lookback",best.slopeLookback],["Entry Valid Candles",best.entryValidCandles],["RR",`1:${best.rr}`],["Minimum Stop-Loss Distance %",best.minStopLossDistancePct],["Max Consecutive Losses / Day",best.maxConsecutiveLosses],["Resolved Win Rate %",best.winRatePct],["Target Hits",best.targetHits],["SL Hits",best.slHits],["EOD Exits",best.eodExits],["Evaluated",`${state.evaluated} / ${state.requested}`]].map(([k,v])=>`<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>${spotTerminal.includes(state.status)?'<button id="applySpotBest" type="button">Apply Best</button>':""}</article>`;
 if(spotTerminal.includes(state.status))$("#applySpotBest").onclick=()=>{for(const k of ["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses"])$("#sb_"+k).value=String(best[k]);$("#sb_minStopLossDistancePct").value=String(best.minStopLossDistancePct);document.querySelector('[data-tab="spotBack"]').click();$("#spotBackStatus").textContent="Optimised strategy parameters applied. Run the 1-Minute Backtest to evaluate them.";};
 }else $("#spotOptBest").innerHTML=state.status==="failed"?`<p class="prep-error">${escapeHtml(state.reason??"Optimisation blocked; no candidates evaluated.")}</p>`:"";
 const rows=spotCandidateRows(state.results??[]),pages=Math.ceil(rows.length/100);spotOptPage=Math.min(spotOptPage,Math.max(0,pages-1));table($("#spotOptResults"),rows.slice(spotOptPage*100,(spotOptPage+1)*100));$("#spotOptPages").innerHTML=rows.length?`<button id="spotPrev" type="button" ${spotOptPage===0?"disabled":""}>Previous</button><span>Page ${spotOptPage+1} / ${pages} · ${rows.length} retained results (retention cap 10,000)</span><button id="spotNext" type="button" ${spotOptPage+1>=pages?"disabled":""}>Next</button>`:"";if($("#spotPrev"))$("#spotPrev").onclick=()=>{spotOptPage--;renderSpotOpt(state);};if($("#spotNext"))$("#spotNext").onclick=()=>{spotOptPage++;renderSpotOpt(state);};
}
$("#runSpotOpt").onclick=async()=>{
 if(!$("#spotOptForm").reportValidity())return;let input;try{input=spotOptBase();spotRequestedCount();}catch(e){$("#spotOptStatus").textContent=e.message;return;}
 $("#runSpotOpt").disabled=true;$("#cancelSpotOpt").disabled=false;$("#spotOptBest").innerHTML="";table($("#spotOptResults"),[]);$("#spotOptPages").innerHTML="";spotOptPage=0;$("#spotOptForm").querySelectorAll("input,select").forEach(el=>el.disabled=true);
 try{const created=await post("/api/spot-optimise",input);spotOptJob=created.jobId;while(true){const state=await get(`/api/spot-optimise/${spotOptJob}`);renderSpotOpt(state);if(spotTerminal.includes(state.status))break;await new Promise(r=>setTimeout(r,250));}}
 catch(e){$("#spotOptStatus").innerHTML=`<p class="prep-error">${escapeHtml(e.message)}</p>`;}finally{$("#runSpotOpt").disabled=false;$("#cancelSpotOpt").disabled=true;spotOptJob=null;$("#spotOptForm").querySelectorAll("input,select").forEach(el=>el.disabled=false);}
};
$("#cancelSpotOpt").onclick=async()=>{if(spotOptJob)try{await post(`/api/spot-optimise/${spotOptJob}/cancel`,{});}catch(e){$("#spotOptStatus").textContent=e.message;}};
updateSpotWarning();
