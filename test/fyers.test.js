import test,{beforeEach} from "node:test";
import assert from "node:assert/strict";
import {get,history,historyRequest,expiredHistory,expiredSymbols,expiryDates,optionChain,parseCandles,exchangeAuthCode,historyRequestDiagnostics,resetHistoryRequestDiagnostics} from "../src/fyers.js";
import {HistoryRequestScheduler} from "../src/history-scheduler.js";
import {sessionDateEpoch,ymdIST,hmIST,addDays} from "../src/time.js";
process.env.FYERS_APP_ID="TEST-100";process.env.FYERS_SECRET_KEY="TEST_SECRET";process.env.FYERS_REDIRECT_URI="http://127.0.0.1:3000/api/fyers/callback";
beforeEach(()=>resetHistoryRequestDiagnostics());
function mock(t,fn){t.mock.method(globalThis,"fetch",fn);}
test("FYERS errors identify endpoint/status/code/params and redact credential echoes",async t=>{
 mock(t,async()=>new Response(JSON.stringify({s:"error",code:-50,message:"Invalid input TEST_TOKEN TEST_SECRET",data:{resolution:"Invalid resolution",access_token:"OTHER_SECRET"}}),{status:422}));
 await assert.rejects(history("TEST_TOKEN","NSE:NIFTY50-INDEX","5S","2026-09-21","2026-09-21"),e=>{
  assert.match(e.message,/FYERS \/history/);assert.match(e.message,/HTTP 422/);assert.match(e.message,/FYERS code=-50/);assert.match(e.message,/Invalid input/);assert.match(e.message,/"resolution":"5S"/);assert.match(e.message,/30 trading days/);assert.doesNotMatch(e.message,/TEST_TOKEN|TEST_SECRET|OTHER_SECRET/);return true;
 });
});
test("non-JSON and transport failures never echo response bodies or credentials",async t=>{
 mock(t,async()=>new Response("TEST_SECRET TEST_TOKEN",{status:502}));await assert.rejects(history("TEST_TOKEN","NSE:NIFTY50-INDEX","1","2026-09-21","2026-09-21"),e=>/HTTP 502/.test(e.message)&&!e.message.includes("TEST_SECRET"));
});
test("auth errors are separate and do not expose auth code/token",async t=>{
 mock(t,async()=>new Response(JSON.stringify({s:"error",message:"auth_code=PRIVATE"}),{status:400}));await assert.rejects(exchangeAuthCode("PRIVATE"),e=>/authentication failed/.test(e.message)&&!e.message.includes("PRIVATE"));
});
test("regular/expired endpoint parameters match published schema and support 5S explicitly",async t=>{
 const calls=[];mock(t,async url=>{calls.push(new URL(url));return new Response(JSON.stringify({s:"ok",candles:[]}));});
 await expiryDates("T","NSE:NIFTY50-INDEX","2026-09-01","2026-09-30");await expiredSymbols("T","NSE:NIFTY50-INDEX","2026-09-22");
 await expiredHistory("T","NSE:NIFTY2692225500CE","1","2026-09-21","2026-09-21");await expiredHistory("T","NSE:NIFTY2692225500CE","5S","2026-09-21","2026-09-21");
 assert.equal(calls[0].searchParams.get("symbol"),"NSE:NIFTY50-INDEX");assert.equal(calls[1].searchParams.get("expiry_date"),"2026-09-22");assert.equal(calls[2].searchParams.get("resolution"),"1");assert.equal(calls[3].searchParams.get("resolution"),"5S");
 assert.equal(calls[2].searchParams.has("cont_flag"),false);assert.equal(calls[2].searchParams.get("date_format"),"1");
 await assert.rejects(expiredHistory("T","NSE:NIFTY2692225500CE","10S","2026-09-21","2026-09-21"),/unsupported resolution/);
 await assert.rejects(get("/history",{symbol:"NSE:NIFTY50-INDEX",resolution:"1",date_format:1,range_from:"2026-02-30",range_to:"2026-09-21"},"T"),/date range/);
});
test("history ranges chunk: minute <=100 days; seconds bounded multi-day ranges, never fallback",async t=>{
 const calls=[];mock(t,async url=>{calls.push(new URL(url));return new Response(JSON.stringify({s:"ok",candles:[]}));});
 await history("T","NSE:NIFTY50-INDEX","1","2026-01-01","2026-04-15");assert.equal(calls.length,2);assert.equal(calls[0].searchParams.get("range_to"),"2026-04-10");
 calls.length=0;await history("T","NSE:NIFTY50-INDEX","5S","2026-09-21","2026-09-23");assert.equal(calls.length,1);assert.ok(calls.every(c=>c.searchParams.get("resolution")==="5S"));assert.equal(calls[0].searchParams.get("range_to"),"2026-09-23");
});
test("100 concurrent equivalent FYERS history requests make one network request",async t=>{
 let calls=0;mock(t,async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return new Response(JSON.stringify({s:"ok",candles:[]}));});
 const requests=Array.from({length:100},()=>history("DEDUP_TOKEN","NSE:NIFTY50-INDEX","5S","2026-09-09","2026-09-09"));
 const all=await Promise.all(requests),stats=historyRequestDiagnostics();assert.equal(all.length,100);assert.ok(all.every(x=>x.length===0));assert.equal(calls,1);assert.equal(stats.logicalHistoryRequests,100);assert.equal(stats.networkHistoryRequests,1);assert.equal(stats.inFlightDeduplications,99);
});
test("successful sequential history requests use process cache",async t=>{
 let calls=0;mock(t,async()=>{calls++;return new Response(JSON.stringify({s:"ok",candles:[]}));});
 await history("CACHE_TOKEN","NSE:NIFTY50-INDEX","5S","2026-09-09","2026-09-09");await history("CACHE_TOKEN","NSE:NIFTY50-INDEX","5S","2026-09-09","2026-09-09");
 const stats=historyRequestDiagnostics();assert.equal(calls,1);assert.equal(stats.logicalHistoryRequests,2);assert.equal(stats.networkHistoryRequests,1);assert.equal(stats.cacheHits,1);
});
test("global minimum interval spaces distinct historical network requests",async()=>{
 const timestamps=[],scheduler=new HistoryRequestScheduler({maxConcurrent:2,minIntervalMs:25,logger:{info(){}}});
 const run=()=>new Response(JSON.stringify({s:"ok",candles:[]}));
 await Promise.all(["A","B"].map(symbol=>scheduler.request({endpoint:"GET /data/history",params:{symbol,resolution:"1"},token:"T",run:async()=>{timestamps.push(Date.now());return run();}})));
 assert.equal(timestamps.length,2);assert.ok(timestamps[1]-timestamps[0]>=20,`request separation was ${timestamps[1]-timestamps[0]}ms`);
});
test("429 cooldown is global for concurrent queued historical work",async()=>{
 let secondStarted=0,triggerOther;const other=new Promise(resolve=>triggerOther=resolve),scheduler=new HistoryRequestScheduler({maxConcurrent:2,minIntervalMs:0,maxRetries:1,baseDelayMs:25,random:()=>0,logger:{info(){}}});let firstAttempts=0;
 const first=scheduler.request({endpoint:"GET /data/history",params:{symbol:"A"},token:"T",onState:s=>{if(s.status==="waiting_rate_limit")triggerOther(scheduler.request({endpoint:"GET /data/history",params:{symbol:"B"},token:"T",run:async()=>{secondStarted=Date.now();return new Response(JSON.stringify({s:"ok",candles:[]}));}}));},run:async()=>++firstAttempts===1?new Response("{}",{status:429}):new Response(JSON.stringify({s:"ok",candles:[]}))});
 const firstStart=Date.now();await first;await other;assert.equal(firstAttempts,2);assert.ok(secondStarted-firstStart>=20);assert.equal(scheduler.diagnostics().rateLimitResponses,1);
});
test("option premium history is cached through the same scheduler and failed responses are not cached",async t=>{
 let optionCalls=0,historyCalls=0;mock(t,async url=>{if(new URL(url).pathname.endsWith("historical-data")){optionCalls++;return new Response(JSON.stringify({s:"ok",candles:[]}));}historyCalls++;return historyCalls===1?new Response(JSON.stringify({s:"error",code:-50,message:"invalid input"}),{status:400}):new Response(JSON.stringify({s:"ok",candles:[]}));});
 await expiredHistory("OPTION_CACHE","NSE:NIFTY2692295PE","1","2026-09-09","2026-09-09");await expiredHistory("OPTION_CACHE","NSE:NIFTY2692295PE","1","2026-09-09","2026-09-09");assert.equal(optionCalls,1);
 await assert.rejects(history("RETRY_ERROR","NSE:NIFTY50-INDEX","1","2026-09-09","2026-09-09"),/HTTP 400/);assert.deepEqual(await history("RETRY_ERROR","NSE:NIFTY50-INDEX","1","2026-09-09","2026-09-09"),[]);assert.equal(historyCalls,2);
});
test("429 retries are bounded and honor Retry-After",async()=>{
 const waits=[],scheduler=new HistoryRequestScheduler({maxConcurrent:1,maxRetries:2,minIntervalMs:0,delay:async ms=>waits.push(ms),logger:{info(){}}});let calls=0;
 const result=await scheduler.request({endpoint:"GET /data/history",params:{symbol:"NSE:NIFTY50-INDEX",resolution:"5S"},token:"T",run:async()=>++calls===1?new Response("{}",{status:429,headers:{"Retry-After":"0.25"}}):new Response(JSON.stringify({s:"ok",candles:[]}))});
 assert.equal(calls,2);assert.deepEqual(waits,[250]);assert.equal(result.status,200);assert.equal(scheduler.diagnostics().rateLimitResponses,1);assert.equal(scheduler.diagnostics().retries,1);
});
test("repeated 429 responses stop after configured attempts",async()=>{
 const scheduler=new HistoryRequestScheduler({maxConcurrent:1,maxRetries:2,minIntervalMs:0,baseDelayMs:0,random:()=>0,delay:async()=>{},logger:{info(){}}});let calls=0;
 const result=await scheduler.request({endpoint:"GET /data/history",params:{},token:"T",run:async()=>{calls++;return new Response(JSON.stringify({s:"error",code:-429,message:"request limit reached"}),{status:429});}});
 assert.equal(calls,3);assert.equal(result.status,429);assert.equal(scheduler.diagnostics().retries,2);assert.equal(scheduler.diagnostics().rateLimitResponses,3);
});
test("cancellation interrupts Retry-After wait",async()=>{
 const scheduler=new HistoryRequestScheduler({maxConcurrent:1,maxRetries:2,logger:{info(){}}}),controller=new AbortController();let calls=0;
 const pending=scheduler.request({endpoint:"GET /data/history",params:{},token:"T",signal:controller.signal,onState:()=>controller.abort(),run:async()=>{calls++;return new Response("{}",{status:429,headers:{"Retry-After":"30"}});}});
 await assert.rejects(pending,/cancelled/);assert.equal(calls,1);
});
test("candle schema, resolution, null values, duplicates validated",()=>{
 assert.throws(()=>parseCandles({resolution:"1",candles:[]},"5S"),/refusing/);
 assert.throws(()=>parseCandles({candles:[[1,null,2,1,1,1]]},"1"),/INVALID FYERS CANDLE/);
 assert.throws(()=>parseCandles({s:"ok"},"1"),/missing candles/);
 assert.deepEqual(parseCandles({columns:["timestamp","close","high","low","open","volume"],candles:[[1,2,3,1,1,9]]},"1"),[{t:1,o:1,h:3,l:1,c:2,v:9}]);
});
test("exact underlying history parameters use documented index symbols and one IST calendar date",async t=>{
 const calls=[];mock(t,async url=>{calls.push(new URL(url));return new Response(JSON.stringify({s:"ok",candles:[]}));});
 await history("PRIVATE","NSE:NIFTY50-INDEX","5S","2026-09-09","2026-09-09");
 await history("PRIVATE","NSE:NIFTYBANK-INDEX","5S","2026-09-09","2026-09-09");
 assert.equal(calls.length,2);
 for(const [i,symbol]of [[0,"NSE:NIFTY50-INDEX"],[1,"NSE:NIFTYBANK-INDEX"]]){
  const u=calls[i];assert.equal(u.origin+u.pathname,"https://api-t1.fyers.in/data/history");
  assert.deepEqual(Object.fromEntries(u.searchParams),{symbol,resolution:"5S",date_format:"1",range_from:"2026-09-09",range_to:"2026-09-09",cont_flag:"0"});
 }
 assert.deepEqual(historyRequest("NSE:NIFTY50-INDEX","5S","2026-09-09","2026-09-09"),{symbol:"NSE:NIFTY50-INDEX",resolution:"5S",date_format:1,range_from:"2026-09-09",range_to:"2026-09-09",cont_flag:0});
 const epoch= sessionDateEpoch("2026-09-09","09:15");assert.equal(ymdIST(epoch),"2026-09-09");assert.equal(hmIST(epoch),"09:15");
});
test("documented FYERS array shape accepts numeric strings, extra trailing fields and zero index volume",()=>{
 const timestamp=sessionDateEpoch("2026-09-09","09:15"),rows=[[timestamp,"24850.10","24855.00","24845.00","24852.00","0","optional-extra"]];
 assert.deepEqual(parseCandles({s:"ok",candles:rows},"5S",{symbol:"NSE:NIFTY50-INDEX",date:"2026-09-09",params:{resolution:"5S"}}),[{t:timestamp,o:24850.1,h:24855,l:24845,c:24852,v:0}]);
 assert.equal(ymdIST(timestamp),"2026-09-09");assert.equal(hmIST(timestamp),"09:15");
});
test("observed malformed pre-open 5S candles are reported and excluded outside the session only",async t=>{
 const pre=sessionDateEpoch("2026-09-09","09:08"),open=sessionDateEpoch("2026-09-09","09:15"),calls=[];
 mock(t,async()=>new Response(JSON.stringify({s:"ok",candles:[[pre,23635.1,23635.1,23635.1,23525.45,0],[pre+25,23522.7,23522.05,23522.05,23522.05,0],[open,24850,24855,24845,24852,0]]})));
 const rows=await history("OBSERVED_PREOPEN","NSE:NIFTY50-INDEX","5S","2026-09-09","2026-09-09",{onInvalidOutsideSession:detail=>calls.push(detail)});
 assert.equal(rows.length,1);assert.equal(rows[0].t,open);assert.equal(rows.diagnostics.invalidOutsideSessionCount,2);assert.equal(calls[0].count,2);assert.equal(calls[0].examples[0].index,0);
 const malformed=sessionDateEpoch("2026-09-09","09:15");
 assert.throws(()=>parseCandles({s:"ok",candles:[[malformed,24850,24855,24845,24900,0]]},"5S",{date:"2026-09-09",allowMalformedOutsideSession:true}),/INVALID FYERS CANDLE.*close 24900/s);
});
test("invalid FYERS candles identify index, raw data, shape, length and each field reason",()=>{
 const ts=sessionDateEpoch("2026-09-09","09:15"),rows=[
  [ts,"24850","24855","24845",undefined,"0"],
  [ts+5,"24850","NaN","24845","24852","0"],
  [ts+10,"24850","24840","24845","24852","0"],
  [ts*1000,"24850","24855","24845","24852","0"]
 ];
 assert.throws(()=>parseCandles({s:"ok",candles:rows},"5S",{endpoint:"GET /data/history",symbol:"NSE:NIFTY50-INDEX",date:"2026-09-09",params:{symbol:"NSE:NIFTY50-INDEX",resolution:"5S",range_from:"2026-09-09",range_to:"2026-09-09",date_format:1,cont_flag:0}}),e=>{
  assert.match(e.message,/INVALID FYERS CANDLE/);assert.match(e.message,/Invalid candles: 4/);assert.match(e.message,/Candle index: 0/);assert.match(e.message,/Actual length: 6/);assert.match(e.message,/Expected shape: \[timestamp, open, high, low, close, volume\]/);assert.match(e.message,/close: must be a finite/);assert.match(e.message,/high: must be a finite/);assert.match(e.message,/high .* below low/);assert.match(e.message,/appears to be milliseconds/);return true;
 });
});
test("empty FYERS history is no data, not a malformed candle",async t=>{
 mock(t,async()=>new Response(JSON.stringify({s:"ok",candles:[]})));
 assert.deepEqual(await history("T","NSE:NIFTY50-INDEX","5S","2026-09-09","2026-09-09"),[]);
});
test("required endpoint fields and per-request expiry limits reject locally",async t=>{
 mock(t,async()=>assert.fail("invalid request must not reach FYERS"));
 await assert.rejects(get("/history",{symbol:"NSE:NIFTY50-INDEX"},"T"),/missing required resolution/);
 await assert.rejects(expiryDates("T","NSE:NIFTY50-INDEX","2025-01-01","2026-09-30"),/maximum 366/);
});
test("expired-only FYERS endpoints never receive today/future expiry dates",async t=>{
 const today=ymdIST(Date.now()/1000),future=addDays(today,1);
 mock(t,async()=>assert.fail("expired-only invalid date must not reach FYERS"));
 await assert.rejects(expiryDates("T","NSE:NIFTY50-INDEX",today,future),/expired dates only/);
 await assert.rejects(expiredSymbols("T","NSE:NIFTY50-INDEX",today),/requires an expired expiry date/);
 await assert.rejects(expiredHistory("T","NSE:NIFTY26100525000CE","1",today,today),/requires expired contracts and past dates/);
});
test("active option-chain lookup uses actual selected expiry timestamp and safe request parameters",async t=>{
 const calls=[];mock(t,async url=>{calls.push(new URL(url));return new Response(JSON.stringify({s:"ok",data:{expiryData:[],optionsChain:[]}}));});
 await optionChain("T","NSE:NIFTY50-INDEX",1791460800);assert.equal(calls.length,1);assert.equal(calls[0].pathname,"/data/options-chain-v3");assert.equal(calls[0].searchParams.get("symbol"),"NSE:NIFTY50-INDEX");assert.equal(calls[0].searchParams.get("timestamp"),"1791460800");assert.equal(calls[0].searchParams.get("strikecount"),"50");
});
test("OAuth exchanges code server-side using SHA-256 app ID hash",async t=>{
 const {createHash}=await import("node:crypto");
 mock(t,async(url,options)=>{
  assert.equal(url,"https://api-t1.fyers.in/api/v3/validate-authcode");assert.equal(options.method,"POST");
  assert.deepEqual(JSON.parse(options.body),{grant_type:"authorization_code",appIdHash:createHash("sha256").update("TEST-100:TEST_SECRET").digest("hex"),code:"MOCK_CODE"});
  assert.doesNotMatch(options.body,/TEST_SECRET/);return new Response(JSON.stringify({s:"ok",access_token:"MOCK_TOKEN"}));
 });assert.equal(await exchangeAuthCode("MOCK_CODE"),"MOCK_TOKEN");
});
