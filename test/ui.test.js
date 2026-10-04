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
 assert.equal(calls[0].body.emaSeedDate,result.config.emaSeedDate);assert.equal(get("#backStatus").textContent,"Complete");
});
test("Apply Best does not change date/context fields when they differ from optimisation context",async()=>{
 const {get,calls,context}=await ui();setContext(get);get("#b_startDate").value="2026-09-02";await context.applyBest(result);assert.equal(calls.length,0);assert.equal(get("#b_startDate").value,"2026-09-02");assert.match(get("#optStatus").textContent,/No dates or fixed settings were changed/);
});
test("failed market preparation clears any prior ledger and shows BACKTEST NOT RUN",async()=>{
 const {get,context,setFailBacktest}=await ui();get("#summary").innerHTML="old summary";get("#trades").innerHTML="old trades";setFailBacktest(true);
 await context.runBacktest();assert.equal(get("#summary").innerHTML,"");assert.equal(get("#trades").innerHTML,"");assert.match(get("#backStatus").textContent,/BACKTEST NOT RUN/);assert.match(get("#backStatus").textContent,/market data could not be prepared/);
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
