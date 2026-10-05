import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {createApp} from "../src/server.js";
import {cfg} from "./fixtures.js";
import {fixture} from "./fixtures.js";
import {optimise as runOptimisation} from "../src/optimiser.js";
import {rm} from "node:fs/promises";
import {sessionDateEpoch,addDays} from "../src/time.js";
import {createMarketStore} from "../src/market.js";
process.env.FYERS_APP_ID="TEST-100";process.env.FYERS_SECRET_KEY="UNIT_TEST_SECRET";process.env.FYERS_REDIRECT_URI="http://127.0.0.1:3000/api/fyers/callback";
async function server(t,deps){const app=createApp(deps),server=app.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;}
const post=(url,body)=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
test("HTTP backtest validates config, preserves server-only token, and returns safe errors",async t=>{
 let seen;const base=await server(t,{token:"PRIVATE_TOKEN",backtest:async(token,cfg)=>{seen={token,cfg};return {config:cfg,trades:[]};}});
 const response=await post(base+"/api/backtest",{...cfg,access_token:"MALICIOUS_ECHO"});const text=await response.text();assert.equal(response.status,200);assert.doesNotMatch(text,/PRIVATE_TOKEN|MALICIOUS_ECHO/);assert.equal(seen.token,"PRIVATE_TOKEN");
 const stale=await post(base+"/api/backtest",{...cfg,resolution:"15",expiryType:"MONTHLY"});assert.equal(stale.status,200);assert.equal(seen.cfg.resolution,"1");assert.equal(seen.cfg.expiryType,"WEEKLY");
 const status=await (await fetch(base+"/api/status")).json();assert.equal(status.connected,true);assert.match(status.build,/optimiser=FAST\/EXHAUSTIVE-streaming/);
});
test("HTTP backtest reports preparation failure as NOT RUN, not a valid empty ledger",async t=>{
 const networkFetch=globalThis.fetch.bind(globalThis),date=cfg.startDate,session=sessionDateEpoch(date,"09:15");
 t.mock.method(globalThis,"fetch",async(url,options)=>{
  if(!String(url).startsWith("https://api-t1.fyers.in/data/"))return networkFetch(url,options);
  const q=new URL(url).searchParams,res=q.get("resolution"),from=q.get("range_from");
  if(res==="5S")return new Response(JSON.stringify({s:"ok",candles:[]}));
  const warm=Array.from({length:4},(_,i)=>[sessionDateEpoch(addDays(date,-4),"15:10")+i*60,100,101,99,100,0]);
  const candles=[...warm,...Array.from({length:360},(_,i)=>[session+i*60,100,101,99,100,0])];
  return new Response(JSON.stringify({s:"ok",candles}));
 });
 const base=await server(t,{token:"PREP_FAILURE_TOKEN"}),response=await post(base+"/api/backtest",cfg),body=await response.json();
 assert.equal(response.status,503);assert.equal(body.status,"failed");assert.equal(body.phase,"preparing_data");assert.equal(body.incompleteData,true);assert.match(body.error,/BACKTEST NOT RUN/);assert.match(body.error,/No mandatory underlying 5-second candles returned/);assert.equal(body.trades,undefined);
});
test("HTTP optimisation start/progress/cancel endpoints remain responsive",async t=>{
 let finish;const base=await server(t,{token:"PRIVATE",optimise:async(token,cfg,options)=>{
  options.onProgress({status:"running",processed:10,totalCombinations:100,materialisedRows:10});
  return new Promise(resolve=>{finish=()=>resolve({status:"cancelled",processed:10,totalCombinations:100,materialisedRows:10,exhaustive:false});options.signal.addEventListener("abort",finish,{once:true});});
 }});
 const input={...cfg,emaMin:2,emaMax:3,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:1,validMax:1,rrMin:1,rrMax:1,rrStep:1,lossMin:1,lossMax:1};
 const {id}=await (await post(base+"/api/optimise",input)).json();const progress=await(await fetch(base+`/api/optimise/${id}`)).json();assert.equal(progress.status,"running");assert.equal(progress.processed,10);
 assert.equal((await post(base+"/api/optimise",input)).status,400);
 await post(base+`/api/optimise/${id}/cancel`,{});const done=await(await fetch(base+`/api/optimise/${id}`)).json();assert.equal(done.status,"cancelled");assert.equal(done.exhaustive,false);finish();
});
test("backtest status exposes live stage units and percentages without changing data work",{timeout:5000},async t=>{
 let report,release;const base=await server(t,{token:"PRIVATE",backtest:async(_token,_cfg,options)=>{report=options.onPreparationProgress;report({stage:"execution_spot",status:"fetching",completed:0,total:20,unit:"chunks",activity:"Fetching 5-second NIFTY spot data — chunk 1 / 20"});return new Promise(resolve=>{release=()=>resolve({summary:{trades:0},trades:[],skipped:[]});});}});
 const pending=post(base+"/api/backtest",cfg);let status;
 try{
  for(let i=0;i<30;i++){status=await(await fetch(base+"/api/status")).json();if(status.marketDataProgress?.stages?.execution_spot)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(status.marketDataProgress.status,"preparing_data");assert.equal(status.marketDataProgress.stages.execution_spot.percentage,0);assert.equal(status.marketDataProgress.stages.execution_spot.completed,0);
  for(const [completed,percentage]of [[1,5],[10,50],[19,95],[20,100]]){report({stage:"execution_spot",status:completed===20?"complete":"fetching",completed,total:20,unit:"chunks",activity:`${completed} of 20`});status=await(await fetch(base+"/api/status")).json();assert.equal(status.marketDataProgress.stages.execution_spot.percentage,percentage);assert.equal(status.marketDataProgress.stages.execution_spot.completed,completed);}
 }finally{release?.();}
 assert.equal((await pending).status,200);
});
test("HTTP optimiser exposes queued/preparation and rate-limit wait states without evaluating",async t=>{
 const base=await server(t,{token:"PRIVATE",optimise:async(_token,_cfg,options)=>{options.onProgress({status:"waiting_rate_limit",stage:"Preparing Market Data",requested:12,evaluated:0,message:"FYERS request limit reached. Waiting before retry. Retry 1/2"});return new Promise(resolve=>options.signal.addEventListener("abort",()=>resolve({status:"cancelled",mode:"FAST",requested:12,evaluated:0,bestResult:null,exhaustive:false}),{once:true}));}});
 const input={...cfg,mode:"FAST",emaMin:2,emaMax:2,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:1,validMax:1,rrMin:1,rrMax:1,rrStep:1,lossMin:1,lossMax:1};
 const job=await(await post(base+"/api/optimise",input)).json();assert.equal(job.status,"queued");let status;
 for(let i=0;i<30;i++){status=await(await fetch(base+`/api/optimise/${job.jobId}`)).json();if(status.status==="waiting_rate_limit")break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(status.status,"waiting_rate_limit");assert.equal(status.requested,1);assert.equal(status.evaluated,0);assert.match(status.message,/request limit reached/);await post(base+`/api/optimise/${job.jobId}/cancel`,{});
});
test("OAuth callback fails safely without state and redirects without auth code",async t=>{
 let exchanged=false;const base=await server(t,{exchangeAuthCode:async()=>{exchanged=true;return "PRIVATE";}});
 const response=await fetch(base+"/api/fyers/callback?auth_code=PRIVATE_CODE&state=unknown",{redirect:"manual"});assert.equal(response.status,302);assert.equal(response.headers.get("location"),"/?auth=failed");assert.equal(exchanged,false);assert.doesNotMatch(await response.text(),/PRIVATE_CODE/);assert.equal(response.headers.get("referrer-policy"),"no-referrer");
});
test("HTTP error preserves FYERS numeric code while redacting token",async t=>{
 const base=await server(t,{token:"PRIVATE_TOKEN",backtest:async()=>{throw new Error("FYERS /history rejected request (HTTP 422); FYERS code=-50; message=Invalid input PRIVATE_TOKEN");}});
 const response=await post(base+"/api/backtest",cfg),body=await response.json();assert.match(body.error,/FYERS code=-50/);assert.doesNotMatch(body.error,/PRIVATE_TOKEN/);
});
test("mocked OAuth login, callback, connected status and server-only token complete without copy/paste",async t=>{
 let base,exchanges=0,usedToken;
 base=await server(t,{callbackUrl:()=>new URL(base+"/api/fyers/callback"),loginUrl:state=>`https://mock-fyers.invalid/authorize?state=${state}`,exchangeAuthCode:async code=>{assert.equal(code,"PRIVATE_AUTH_CODE");exchanges++;return "PRIVATE_ACCESS_TOKEN";},backtest:async token=>{usedToken=token;return {trades:[]};}});
 assert.equal((await(await fetch(base+"/api/status")).json()).connected,false);
 const login=await fetch(base+"/api/fyers/login",{redirect:"manual"}),location=new URL(login.headers.get("location")),cookie=login.headers.get("set-cookie");
 assert.equal(location.origin,"https://mock-fyers.invalid");assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Lax/i);assert.match(cookie,/Path=\/api\/fyers\/callback/);
 const callback=base+`/api/fyers/callback?state=${location.searchParams.get("state")}&auth_code=PRIVATE_AUTH_CODE`;
 const response=await fetch(callback,{redirect:"manual",headers:{cookie:cookie.split(";")[0]}});
 assert.equal(response.headers.get("location"),"/?connected=1");assert.doesNotMatch(await response.text(),/PRIVATE_/);assert.match(response.headers.get("set-cookie"),/Expires=Thu, 01 Jan 1970/);
 const status=await fetch(base+"/api/status");assert.equal((await status.json()).connected,true);assert.equal(status.headers.get("cache-control"),"no-store");
 assert.equal((await post(base+"/api/backtest",cfg)).status,200);assert.equal(usedToken,"PRIVATE_ACCESS_TOKEN");
 const replay=await fetch(callback,{redirect:"manual",headers:{cookie:cookie.split(";")[0]}});assert.equal(replay.headers.get("location"),"/?auth=failed");assert.equal(exchanges,1);
 for(const path of ["/","/app.js","/style.css"]){const r=await fetch(base+path);assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/PRIVATE_AUTH_CODE|PRIVATE_ACCESS_TOKEN/);}
});
test("OAuth aligns callback hostname before creating the state cookie",async t=>{
 const base=await server(t,{callbackUrl:()=>new URL("http://localhost:3000/api/fyers/callback"),loginUrl:()=>assert.fail("must align host first")});
 const r=await fetch(base+"/api/fyers/login",{redirect:"manual"});assert.equal(r.headers.get("location"),"http://localhost:3000/api/fyers/login");assert.equal(r.headers.get("set-cookie"),null);
});
test("OAuth exchange failure is sanitized and missing cookie cannot authenticate",async t=>{
 let base,exchanges=0;base=await server(t,{callbackUrl:()=>new URL(base+"/api/fyers/callback"),loginUrl:state=>`https://mock-fyers.invalid/?state=${state}`,exchangeAuthCode:async()=>{exchanges++;throw new Error("PRIVATE_CODE PRIVATE_SECRET PRIVATE_TOKEN");}});
 const login=await fetch(base+"/api/fyers/login",{redirect:"manual"}),state=new URL(login.headers.get("location")).searchParams.get("state"),url=base+`/api/fyers/callback?state=${state}&auth_code=PRIVATE_CODE`;
 const noCookie=await fetch(url,{redirect:"manual"});assert.equal(noCookie.headers.get("location"),"/?auth=failed");assert.equal(exchanges,0);
 const r=await fetch(url,{redirect:"manual",headers:{cookie:login.headers.get("set-cookie").split(";")[0]}});assert.equal(r.headers.get("location"),"/?auth=failed");assert.doesNotMatch(await r.text(),/PRIVATE/);assert.equal(exchanges,1);assert.equal((await(await fetch(base+"/api/status")).json()).connected,false);
});
test("status discards an expired server-held token",async t=>{
 const token="header."+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)-1})).toString("base64url")+".signature";
 const base=await server(t,{token});assert.equal((await(await fetch(base+"/api/status")).json()).connected,false);assert.equal((await post(base+"/api/backtest",cfg)).status,400);
});

test("real HTTP FAST route evaluates the 112,480,000 remaining Cartesian space with zero row budget",async t=>{
 let result;const base=await server(t,{token:"PRIVATE_HTTP",optimise:async(token,config,options)=>{
  result=await runOptimisation(token,config,{...options,data:fixture().data,maxBytes:0,fastLimit:32,evaluate:async(_data,cfg)=>({summary:{totalReturnPct:cfg.emaLength+cfg.slopeLookback+cfg.entryValidCandles+cfg.rr+cfg.maxConsecutiveLosses+(cfg.expiryType==="MONTHLY"?3:0),netPnl:100,totalCharges:0,trades:1,ambiguousCount:0,incompleteData:false},skipped:[]})});
  t.after(()=>result?.store?.dir&&rm(result.store.dir,{recursive:true,force:true}));return result;
 }});
 const input={...cfg,mode:"FAST",expiryType:"ALL",emaMin:5,emaMax:300,emaStep:1,slopeMin:1,slopeMax:50,slopeStep:1,validMin:1,validMax:20,rrMin:1,rrMax:10,rrStep:.5,lossMin:1,lossMax:20,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1};
 const started=await post(base+"/api/optimise",input),job=await started.json();assert.equal(started.status,200);assert.equal(job.requested,112480000);assert.equal(job.mode,"FAST");
 let status;for(let i=0;i<100;i++){status=await(await fetch(base+`/api/optimise/${job.jobId}`)).json();if(["complete","failed","incomplete","cancelled"].includes(status.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(status.status,"complete");assert.equal(status.requested,112480000);assert.equal(status.evaluated,32);assert.equal(status.mode,"FAST");assert.equal(status.exhaustive,false);assert.ok(status.bestResult);assert.equal(status.bestResult.maxConsecutiveLossesPerDay,status.bestResult.maxConsecutiveLosses);assert.equal(status.bestResult.expiryType,"WEEKLY");assert.equal(status.storedResults,1);assert.equal(status.retentionLimited,true);
});
test("real optimisation HTTP job fails explicitly before candidates when FYERS preparation fails",async t=>{
 let resultStore;const failingApi={history:async()=>{throw new Error("FYERS API ERROR: GET /data/history rejected request (HTTP 429); FYERS code=-429; message=request limit reached; params={resolution:5S}");}};
 const base=await server(t,{token:"PREP_OPT_TOKEN",optimise:(token,config,options)=>runOptimisation(token,config,{...options,onStore:store=>{resultStore=store;options.onStore?.(store);},store:createMarketStore(token,failingApi),maxBytes:0})});
 const input={...cfg,mode:"FAST",emaMin:2,emaMax:2,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:1,validMax:1,rrMin:1,rrMax:1,rrStep:1,lossMin:1,lossMax:1};
 const job=await(await post(base+"/api/optimise",input)).json();assert.equal(job.status,"queued");assert.equal(job.requested,1);let status;
 for(let i=0;i<100;i++){status=await(await fetch(base+`/api/optimise/${job.jobId}`)).json();if(["failed","incomplete","cancelled","complete"].includes(status.status))break;await new Promise(r=>setTimeout(r,10));}
 t.after(()=>resultStore?.dir&&rm(resultStore.dir,{recursive:true,force:true}));assert.equal(status.status,"failed");assert.equal(status.evaluated,0);assert.equal(status.requested,1);assert.match(status.reason,/Mandatory FYERS market data could not be prepared/);assert.match(status.reason,/No optimisation candidates were evaluated/);assert.match(status.reason,/HTTP 429/);assert.equal(status.bestResult,null);
});

test("real HTTP EXHAUSTIVE route streams all candidates with retention capped below evaluations",async t=>{
 let result;const base=await server(t,{token:"PRIVATE_HTTP",optimise:async(token,config,options)=>{
  result=await runOptimisation(token,config,{...options,data:fixture().data,maxBytes:0,evaluate:async(_data,cfg)=>({summary:{totalReturnPct:cfg.emaLength===3?50:cfg.emaLength,netPnl:0,totalCharges:0,trades:0,ambiguousCount:0,incompleteData:false},skipped:[]})});t.after(()=>result?.store?.dir&&rm(result.store.dir,{recursive:true,force:true}));return result;
 }});
 const input={...cfg,mode:"EXHAUSTIVE",expiryType:"WEEKLY",emaMin:2,emaMax:4,emaStep:1,slopeMin:1,slopeMax:2,slopeStep:1,validMin:1,validMax:2,rrMin:1,rrMax:2,rrStep:1,lossMin:1,lossMax:2};
 const job=await(await post(base+"/api/optimise",input)).json();assert.equal(job.requested,48);let status;
 for(let i=0;i<100;i++){status=await(await fetch(base+`/api/optimise/${job.id}`)).json();if(["complete","failed","incomplete","cancelled"].includes(status.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(status.status,"complete");assert.equal(status.requested,48);assert.equal(status.evaluated,48);assert.equal(status.exhaustive,true);assert.ok(status.bestResult);assert.equal(status.bestResult.emaLength,3);assert.equal(status.bestResult.returnPct,50);assert.equal(status.storedResults,1);
});

test("invalid FAST implementation cannot be reported as completed with zero of zero",async t=>{
 const base=await server(t,{token:"PRIVATE",optimise:async()=>({status:"complete",mode:"FAST",requested:0,evaluated:0,bestResult:null})});
 const input={...cfg,mode:"FAST",emaMin:2,emaMax:2,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:1,validMax:1,rrMin:1,rrMax:1,rrStep:1,lossMin:1,lossMax:1};const job=await(await post(base+"/api/optimise",input)).json();let status;
 for(let i=0;i<100;i++){status=await(await fetch(base+`/api/optimise/${job.id}`)).json();if(status.status==="failed")break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(status.status,"failed");assert.equal(status.requested,1);assert.equal(status.evaluated,0);assert.match(status.reason,/before producing/);
});

test("real optimisation HTTP preparation parses FYERS 5S OHLCV and evaluates FAST",async t=>{
 const calls=[],date=cfg.startDate,sessionStart=sessionDateEpoch(date,"09:15"),networkFetch=globalThis.fetch.bind(globalThis);
 t.mock.method(globalThis,"fetch",async(url,options)=>{
  if(!String(url).startsWith("https://api-t1.fyers.in/data/"))return networkFetch(url,options);
  const u=new URL(url),q=u.searchParams;
  assert.equal(options.headers.Authorization,"TEST-100:PRIVATE_HTTP");
  if(u.pathname==="/data/history"){
   const resolution=q.get("resolution"),from=q.get("range_from"),symbol=q.get("symbol");
   const request={symbol,resolution,range_from:from,range_to:q.get("range_to"),date_format:q.get("date_format"),cont_flag:q.get("cont_flag")};calls.push(request);
   let candles=[];
   if(from===date&&resolution==="5S")candles=[[sessionStart-420,23635.1,23635.1,23635.1,23525.45,0],[sessionStart-395,23522.7,23522.05,23522.05,23522.05,0],...Array.from({length:4321},(_,i)=>[sessionStart+i*5,"24850.10","24855.00","24845.00","24852.00","0"])];
   else candles=[...Array.from({length:4},(_,i)=>[sessionDateEpoch(addDays(date,-4),"15:10")+i*60,"24850","24855","24845","24852","0"]),...Array.from({length:360},(_,i)=>[sessionStart+i*60,"24850.10","24855.00","24845.00","24852.00","0"])];
   return new Response(JSON.stringify({s:"ok",candles}));
  }
  if(u.pathname.endsWith("/expiry-dates"))return new Response(JSON.stringify({s:"ok",data:{expiry_dates:{options:["2026-09-22"]}}}));
  if(u.pathname.endsWith("/underlying-symbols"))return new Response(JSON.stringify({s:"ok",data:{contracts:{options:[{symbol:"NSE:NIFTY26922105CE",lot_size:50}]}}}));
  if(u.pathname.endsWith("/options-chain-v3"))return new Response(JSON.stringify({s:"ok",data:{expiryData:[],optionsChain:[]}}));
  assert.fail(`Unexpected safe FYERS endpoint ${u.pathname}`);
 });
 const base=await server(t,{token:"PRIVATE_HTTP",optimise:(token,config,options)=>runOptimisation(token,config,{...options,maxBytes:0,fastLimit:4,evaluate:async()=>({summary:{totalReturnPct:12,netPnl:12,totalCharges:0,trades:0,ambiguousCount:0,incompleteData:false},skipped:[]})})});
 const input={...cfg,mode:"FAST",expiryType:"WEEKLY",emaMin:2,emaMax:2,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:1,validMax:1,rrMin:1,rrMax:1,rrStep:1,lossMin:1,lossMax:1};
 const created=await post(base+"/api/optimise",input),job=await created.json();assert.equal(created.status,200);assert.equal(job.requested,1);
 // The shared FYERS scheduler deliberately spaces historical requests. Allow
 // enough time for selected-resolution and execution streams to pass through it.
 let status;for(let i=0;i<1200;i++){status=await(await fetch(base+`/api/optimise/${job.jobId}`)).json();if(["complete","failed","incomplete","cancelled"].includes(status.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(status.status,"complete",status.reason);assert.ok(status.evaluated>0);assert.equal(status.bestResult.returnPct,12);assert.equal(status.resolution,"1");
 const monitorRequest=calls.find(x=>x.resolution==="5S");assert.deepEqual(monitorRequest,{symbol:"NSE:NIFTY50-INDEX",resolution:"5S",range_from:date,range_to:date,date_format:"1",cont_flag:"0"});
 assert.ok(calls.every(x=>x.symbol==="NSE:NIFTY50-INDEX"));
});

test("development 5S history diagnostic is authenticated and returns safe request/candle metadata",async t=>{
 const base=await server(t,{token:"PRIVATE_DEBUG_TOKEN",history:async(token,symbol,resolution,from,to)=>{
  assert.equal(token,"PRIVATE_DEBUG_TOKEN");assert.equal(symbol,"NSE:NIFTYBANK-INDEX");assert.equal(resolution,"5S");assert.equal(from,"2026-09-09");assert.equal(to,from);
  return [{t:sessionDateEpoch(from,"09:15"),o:24850,h:24855,l:24845,c:24852,v:0}];
 }});
 const noAuth=await server(t,{});assert.equal((await fetch(noAuth+"/api/debug/fyers-history?symbol=NIFTY&date=2026-09-09&resolution=5S")).status,400);
 const response=await fetch(base+"/api/debug/fyers-history?symbol=BANKNIFTY&date=2026-09-09&resolution=5S"),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.endpoint,"GET /data/history");assert.equal(body.symbol,"NSE:NIFTYBANK-INDEX");assert.equal(body.candleCount,1);assert.equal(body.invalidCount,0);assert.equal(body.params.cont_flag,0);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_DEBUG_TOKEN|Authorization/i);
});
