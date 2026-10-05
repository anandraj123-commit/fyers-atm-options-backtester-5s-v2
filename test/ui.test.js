import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
function element(){return {value:"",innerHTML:"",textContent:"",hidden:false,disabled:false,classList:{add(){},remove(){}},dataset:{},parentElement:{before(){}},replaceChildren(){},append(){},remove(){},click(){},reportValidity:()=>true};}
async function ui(){
 const els=new Map(),get=s=>{if(!els.has(s))els.set(s,element());return els.get(s);},calls=[];
 let connected=false,summary={trades:0,totalReturnPct:18},failBacktest=false;
 const context={document:{querySelector:get,querySelectorAll:()=>[],createElement:element},location:{search:""},URLSearchParams,Date,Number,String,Math,BigInt,setTimeout,setInterval,clearInterval,
  fetch:async(url,init)=>{if(url==="/api/status")return {ok:true,json:async()=>({connected})};calls.push({url,body:JSON.parse(init.body)});if(failBacktest&&url==="/api/backtest")return {ok:false,json:async()=>({error:"BACKTEST NOT RUN\nRequired market data could not be prepared."})};return {ok:true,json:async()=>({summary,trades:[],skipped:[]})};}};
 vm.createContext(context);vm.runInContext(await readFile(new URL("../public/app.js",import.meta.url),"utf8"),context);await context.refreshAuthStatus();
 return {get,calls,context,setConnected:v=>{connected=v;},setSummary:v=>{summary=v;},setFailBacktest:v=>{failBacktest=v;}};
}
const result={mode:"FAST",status:"complete",resolution:"1",evaluated:100,requested:1000,exhaustive:false,config:{resolution:"1",expiryType:"WEEKLY",symbol:"BANKNIFTY",startDate:"2026-09-01",endDate:"2026-09-21",lots:2,startingCapital:100000,optionResolution:"1",emaSeedDate:"2026-08-01"},
 bestResult:{returnPct:18,emaLength:87,slopeLookback:14,entryValidCandles:4,rr:6,maxConsecutiveLosses:8,maxConsecutiveLossesPerDay:8,minStopLossDistancePct:0,expiryType:"WEEKLY"}};
function setContext(get){for(const [k,v]of Object.entries({symbol:"BANKNIFTY",startDate:"2026-09-01",endDate:"2026-09-21",lots:2,startingCapital:100000,optionResolution:"1",resolution:"1",expiryType:"WEEKLY"}))get("#b_"+k).value=String(v);}
test("Apply Best uses exact displayed values, fixed run context and seed, then auto-runs detailed backtest",async()=>{
 const {get,calls,context}=await ui();setContext(get);context.renderBest(result);
 assert.match(get("#best").innerHTML,/\+18\.00%/);assert.match(get("#best").innerHTML,/87/);assert.match(get("#best").innerHTML,/BEST RESULT FOUND — FAST MODE/);
 await context.applyBest(result);assert.equal(calls.length,1);assert.equal(calls[0].url,"/api/backtest");assert.equal(calls[0].body.resolution,"1");
 for(const key of ["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses"])assert.equal(calls[0].body[key],String(result.bestResult[key]));assert.equal(calls[0].body.minStopLossDistancePct,"0");assert.equal(calls[0].body.expiryType,"WEEKLY");
 for(const key of ["symbol","startDate","endDate","startingCapital","lots","optionResolution"])assert.equal(calls[0].body[key],String(result.config[key]));
 assert.equal(calls[0].body.emaSeedDate,result.config.emaSeedDate);assert.match(get("#backStatus").innerHTML,/100%/);assert.match(get("#backStatus").innerHTML,/MARKET DATA READY/);
});
test("Apply Best does not change date/context fields when they differ from optimisation context",async()=>{
 const {get,calls,context}=await ui();setContext(get);get("#b_startDate").value="2026-09-02";await context.applyBest(result);assert.equal(calls.length,0);assert.equal(get("#b_startDate").value,"2026-09-02");assert.match(get("#optStatus").textContent,/No dates or fixed settings were changed/);
});
test("failed market preparation clears any prior ledger and shows BACKTEST NOT RUN",async()=>{
 const {get,context,setFailBacktest}=await ui();get("#summary").innerHTML="old summary";get("#trades").innerHTML="old trades";setFailBacktest(true);
 await context.runBacktest();assert.equal(get("#summary").innerHTML,"");assert.equal(get("#trades").innerHTML,"");assert.match(get("#backStatus").innerHTML,/MARKET DATA PREPARATION FAILED/);assert.match(get("#backStatus").innerHTML,/BACKTEST NOT RUN/);assert.match(get("#backStatus").innerHTML,/market data could not be prepared/);
});
test("backtest preparation UI has one indeterminate bar, truthful stages, activity and terminal states",async()=>{
 const {get,context}=await ui();
 const work=(stage,completed,total,unit)=>({[stage]:{stage,status:"fetching",unit,completed,total,percentage:total?Math.floor(completed/total*100):null,work:{[unit]:{unit,completed,total,percentage:total?Math.floor(completed/total*100):null}}}});
 const initial=context.backPreparationMarkup({message:"Fetching 1-minute SPOT strategy candles",progress:{activeStage:"strategy_spot",currentActivity:"Fetching 1-minute SPOT strategy candles",stages:{strategy_spot:{status:"fetching",work:{chunks:{unit:"chunks",completed:0,total:4,percentage:0}}}}}});
 assert.equal((initial.match(/role="progressbar"/g)||[]).length,1);assert.match(initial,/indeterminate/);assert.match(initial,/overall total work is not yet measurable/);assert.match(initial,/1 Minute Spot/);assert.match(initial,/● Fetching\.\.\./);assert.match(initial,/0% — 0 \/ 4 chunks/);
 const execution=context.backPreparationMarkup({progress:{activeStage:"execution_spot",currentActivity:"Fetching 5-second NIFTY spot data — chunk 12 / 19",stages:{strategy_spot:{status:"complete",work:{chunks:{unit:"chunks",completed:4,total:4,percentage:100}},},execution_spot:{status:"fetching",activity:"Fetching 5-second NIFTY spot data — chunk 12 / 19",work:{chunks:{unit:"chunks",completed:12,total:19,percentage:63}}}}}});assert.match(execution,/5 Second Spot/);assert.match(execution,/100% — 4 \/ 4 chunks/);assert.match(execution,/63% — 12 \/ 19 chunks/);assert.match(execution,/chunk 12 \/ 19/);
 for(const [completed,percentage]of [[0,0],[1,5],[10,50],[19,95],[20,100]]){const rendered=context.backPreparationMarkup({progress:{activeStage:"execution_spot",stages:{execution_spot:{status:"fetching",work:{chunks:{unit:"chunks",completed,total:20,percentage}}}}}});assert.match(rendered,new RegExp(`${percentage}% — ${completed} \\/ 20 chunks`));}
 const waiting=context.backPreparationMarkup({status:"waiting_rate_limit",progress:{activeStage:"execution_spot",currentActivity:"Fetching 5-second NIFTY spot data — chunk 8 / 19",stages:{execution_spot:{status:"waiting_rate_limit",completed:7,total:19,percentage:36,activity:"Waiting before retry",work:{chunks:{unit:"chunks",completed:7,total:19,percentage:36}}}}},wait:{retry:1,maxRetries:2,waitMs:1500}});assert.match(waiting,/Waiting before retry/);assert.match(waiting,/Retry 1\/2/);assert.match(waiting,/36% — 7 \/ 19 chunks/);
 const others=context.backPreparationMarkup({progress:{activeStage:"weekly_expiries",stages:{weekly_expiries:{status:"resolving",work:{sessions:{unit:"sessions",completed:4,total:10,percentage:40}}},option_contracts:{status:"resolving",work:{"expiry catalogs":{unit:"expiry catalogs",completed:6,total:10,percentage:60},contracts:{unit:"contracts",completed:2,total:null,percentage:null}}},option_premiums:{status:"fetching",work:{histories:{unit:"histories",completed:3,total:null,percentage:null}}}}}});assert.match(others,/40% — 4 \/ 10 sessions/);assert.match(others,/60% — 6 \/ 10 expiry catalogs/);assert.match(others,/2 ATM contracts resolved — total not yet known/);assert.match(others,/3 histories completed — total not yet known/);assert.doesNotMatch(others,/3%|37%/);
 const completed=context.backPreparationMarkup({complete:true,progress:{overallPercentage:null}});assert.match(completed,/aria-valuenow="100"/);assert.match(completed,/Overall Progress/);assert.match(completed,/100%/);assert.equal((completed.match(/✓ Complete/g)||[]).length,5);
 const failed=context.backPreparationMarkup({status:"failed",progress:{activeStage:"option_premiums",stages:{strategy_spot:{status:"complete"},execution_spot:{status:"complete"},weekly_expiries:{status:"complete"},option_contracts:{status:"complete"},option_premiums:{status:"failed",work:{histories:{unit:"histories",completed:5,total:8,percentage:62}}}}},error:"BACKTEST NOT RUN\nNO 5S DATA RETURNED"});assert.match(failed,/MARKET DATA PREPARATION FAILED/);assert.match(failed,/NO 5S DATA RETURNED/);assert.match(failed,/✕ Failed/);assert.match(failed,/62% — 5 \/ 8 histories/);
 get("#backStatus").innerHTML=initial;assert.match(get("#backStatus").innerHTML,/prep-progress-fill/);
});
test("OAuth status is fetched and displayed as green Connected or disconnected with Connect link",async()=>{
 const {get,context,setConnected}=await ui();assert.equal(get("#authStatus").textContent,"● FYERS Not Connected");assert.equal(get("#connectFyers").hidden,false);
 setConnected(true);await context.refreshAuthStatus();assert.equal(get("#authStatus").textContent,"● FYERS Connected");assert.equal(get("#authStatus").className,"good");assert.equal(get("#connectFyers").hidden,true);
});
test("fixed strategy/execution/expiry are read-only and option resolution stays separately selectable",async()=>{
 const {get}=await ui(),html=get("#optFields").innerHTML;
 assert.match(html,/<label for="o_resolution">Strategy Resolution<\/label><input id="o_resolution" name="resolution" type="hidden" value="1"><output class="fixed-value" aria-label="Strategy Resolution">1 Minute <small>FIXED<\/small><\/output>/);assert.match(html,/5 Second Spot <small>FIXED<\/small>/);assert.match(html,/Weekly <small>FIXED<\/small>/);assert.doesNotMatch(html,/5 Minutes|15 Minutes|Monthly|>ALL</);
 assert.match(html,/<option value="5S">5 Seconds<\/option>/);for(const name of ["Market","EMA","Slope","Entry Validity","Risk / Reward","Daily Guard"])assert.ok(html.includes(`<legend>${name}</legend>`));
 assert.ok(html.includes("Minimum Stop-Loss Distance"));
 assert.match(get("#modeFields").innerHTML,/<option value="FAST" selected>/);
 const page=await readFile(new URL("../public/index.html",import.meta.url),"utf8");assert.doesNotMatch(page,/Execution monitoring: mandatory FYERS/);assert.match(page,/id="connectFyers"[^>]*href="\/api\/fyers\/login"/);
 const css=await readFile(new URL("../public/style.css",import.meta.url),"utf8");assert.match(css,/@keyframes prep-progress-slide/);assert.match(css,/from\{transform:translateX/);assert.match(css,/to\{transform:translateX/);
});
test("FAST, complete EXHAUSTIVE, partial and cancelled result labels are truthful",async()=>{
 const {context,get}=await ui();assert.match(context.bestTitle(result),/FAST MODE/);
 const complete={...result,mode:"EXHAUSTIVE",exhaustive:true,evaluated:1000};assert.match(context.bestTitle(complete),/BEST POSSIBLE/);
 assert.doesNotMatch(context.bestTitle({...complete,evaluated:999}),/BEST POSSIBLE/);
 assert.match(context.bestTitle({...complete,status:"cancelled"}),/BEFORE INTERRUPTION/);
 assert.match(context.bestTitle({...complete,status:"incomplete"}),/BEFORE INTERRUPTION/);
 assert.doesNotMatch(context.bestTitle({...complete,unavailableCandidates:1}),/BEST POSSIBLE/);
 context.renderProgress({...result,status:"running",stage:"Coarse Search",storedResults:1,elapsed:18,retentionLimited:true});assert.match(get("#optStatus").innerHTML,/FAST OPTIMISATION RUNNING/);assert.match(get("#optStatus").innerHTML,/Best EMA/);assert.match(get("#retentionInfo").textContent,/did not stop evaluation/);
});
test("large EXHAUSTIVE search displays an advance warning and never switches mode",async()=>{
 const {get,context}=await ui();const fields={mode:"EXHAUSTIVE",emaMin:5,emaMax:300,emaStep:1,slopeMin:1,slopeMax:50,slopeStep:1,validMin:1,validMax:20,rrMin:1,rrMax:10,rrStep:.5,lossMin:1,lossMax:20,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1};
 for(const [k,v]of Object.entries(fields))get("#o_"+k).value=String(v);assert.equal(context.requestedCount(),112480000n);context.updateSearchDescription();assert.equal(get("#searchWarning").hidden,false);assert.match(get("#searchWarning").textContent,/many hours/);assert.equal(get("#o_mode").value,"EXHAUSTIVE");
});
test("HTML table keeps existing charge columns, escapes data and paginates trade rows",async()=>{
 const {get,context}=await ui();const rows=Array.from({length:250},(_,i)=>({tradeNo:i+1,brokerage:40,stt:5,exchange:1,clearing:1,sebi:.01,gst:7,stamp:.03,ipft:0,contract:"<script>"}));context.pagedTable(get("#trades"),rows);
 const html=get("#trades").innerHTML;assert.equal((html.match(/<tr>/g)||[]).length,101);assert.match(html,/<th>clearing<\/th>/);assert.match(html,/<th>ipft<\/th>/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test("invalid optimisation ranges leave Run available and do not start a job",async()=>{
 const {get,context,calls}=await ui();get("#o_emaMin").value="10";get("#o_emaMax").value="5";get("#o_emaStep").value="1";
 await context.runOptimisation();assert.equal(get("#runOpt").disabled,false);assert.equal(calls.length,0);assert.match(get("#optStatus").textContent,/Invalid range/);
});
