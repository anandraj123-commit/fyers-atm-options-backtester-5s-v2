// Optional real-Chrome smoke test. All authentication and financial results are
// explicitly mocked; this does not contact FYERS or validate live credentials.
// Run: node test/browser-smoke.mjs (requires installed Google Chrome).
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {createApp} from "../src/server.js";
import {optimise as runOptimisation} from "../src/optimiser.js";
import {fixture} from "./fixtures.js";
const profile=await mkdtemp(join(tmpdir(),"fyers-ui-smoke-"));
let base,backtestInput,winningReturn,winningParams,winningConfig,chrome,ws,server;
const app=createApp({callbackUrl:()=>new URL(base+"/api/fyers/callback"),loginUrl:state=>base+`/api/fyers/callback?state=${state}&auth_code=MOCK_CODE`,exchangeAuthCode:async()=>"MOCK_PRIVATE_TOKEN",
 backtest:async(token,cfg,options)=>{assert.equal(token,"MOCK_PRIVATE_TOKEN");backtestInput=cfg;options.onProgress("Fetching 1m strategy SPOT candles: mocked browser smoke");await new Promise(resolve=>setTimeout(resolve,350));return {summary:{trades:0,totalReturnPct:winningReturn},trades:[],skipped:[]};},
 optimise:async(token,cfg,options)=>{const result=await runOptimisation(token,cfg,{...options,data:fixture().data,maxBytes:0,fastLimit:60,evaluate:async(_data,c)=>{
  const returnPct=c.emaLength+c.slopeLookback+c.entryValidCandles+c.rr+c.maxConsecutiveLosses+c.minStopLossDistancePct;
  return {summary:{totalReturnPct:returnPct,netPnl:returnPct,totalCharges:0,trades:1,ambiguousCount:0,incompleteData:false},skipped:[]};
 }});winningReturn=result.bestResult?.returnPct;winningParams=result.bestResult;winningConfig=result.config;return result;}});
try{
 server=app.listen(0,"127.0.0.1");await once(server,"listening");base=`http://127.0.0.1:${server.address().port}`;
 chrome=spawn(process.env.CHROME_PATH??"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
 const debuggerUrl=await new Promise((resolve,reject)=>{let log="";const timer=setTimeout(()=>reject(new Error("Chrome debugger startup timed out")),15000);chrome.on("error",reject);chrome.stderr.on("data",chunk=>{log+=chunk;const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
 ws=new WebSocket(debuggerUrl);await once(ws,"open");let seq=0;const pending=new Map();ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}});
 const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const {targetId}=await cdp("Target.createTarget",{url:"about:blank"}),{sessionId}=await cdp("Target.attachToTarget",{targetId,flatten:true});
 const send=(method,params)=>cdp(method,params,sessionId);
 const evaluate=async expression=>{const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+": "+r.result?.description);return r.result.value;};
 const until=async expression=>{for(let n=0;n<100;n++){try{if(await evaluate(expression))return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error("Browser condition timed out: "+expression);};
 await send("Page.enable");await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await send("Page.navigate",{url:base});
 await until(`document.querySelector('#authStatus')?.textContent === '● FYERS Not Connected' && document.querySelector('#b_resolution')`);
 const build=await evaluate(`fetch('/api/status').then(r=>r.json()).then(x=>x.build)`);assert.match(build,/optimiser=FAST\/EXHAUSTIVE-streaming/);
 assert.equal(await evaluate(`document.querySelector('#b_resolution').value`),"1");
 assert.equal(await evaluate(`document.querySelector('#backFields').innerText.includes('1 Minute') && document.querySelector('#backFields').innerText.includes('5 Second Spot') && document.querySelector('#backFields').innerText.includes('Weekly')`),true);
 assert.equal(await evaluate(`document.querySelector('#backFields').innerText.includes('5 Minutes') || document.querySelector('#backFields').innerText.includes('15 Minutes') || document.querySelector('#backFields').innerText.includes('Monthly')`),false);
 assert.equal(await evaluate(`document.body.innerText.includes('Execution monitoring: mandatory FYERS')`),false);
 await evaluate(`document.querySelector('#connectFyers').click()`);await until(`document.querySelector('#authStatus')?.textContent === '● FYERS Connected'`);
 assert.equal(await evaluate(`getComputedStyle(document.querySelector('#authStatus')).color`),"rgb(101, 230, 165)");
 assert.equal(await evaluate(`document.body.innerHTML.includes('MOCK_CODE') || document.body.innerHTML.includes('MOCK_PRIVATE_TOKEN')`),false);
 await evaluate(`document.querySelector('[data-tab="opt"]').click()`);
 await evaluate(`document.querySelector('#o_startDate').value='2026-09-21';document.querySelector('#o_endDate').value='2026-09-21';document.querySelector('#o_mode').value='EXHAUSTIVE';document.querySelector('#o_mode').onchange()`);
 assert.equal(await evaluate(`document.querySelector('#searchWarning').hidden`),false);
 await evaluate(`document.querySelector('#o_mode').value='FAST';document.querySelector('#o_mode').onchange();document.querySelector('#runOpt').click()`);
 await until(`document.querySelector('#apply') && !document.querySelector('#runOpt').disabled && document.querySelector('#optStatus').textContent.includes('FAST OPTIMISATION COMPLETE')`);
 const resultInfo=await evaluate(`({status:document.querySelector('#optStatus').textContent,card:document.querySelector('#best').textContent})`);
 assert.match(resultInfo.status,/60/);assert.match(resultInfo.status,/112,480,000/);assert.match(resultInfo.card,/112,480,000/);assert.match(resultInfo.card,/60/);
 winningReturn=Number((await evaluate(`document.querySelector('.best-return').textContent`)).replace("%",""));assert.ok(winningReturn>0);
 assert.equal(await evaluate(`document.querySelector('.best-card h3').textContent`),"BEST RESULT FOUND — FAST MODE");
 await writeFile(join(tmpdir(),"fyers-ui-desktop.png"),Buffer.from((await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
 await evaluate(`document.querySelector('#apply').click()`);assert.equal(await evaluate(`!!document.querySelector('#backStatus .prep-progress-fill.indeterminate')`),true);await until(`document.querySelector('#backStatus').innerHTML.includes('aria-valuenow="100"') && document.querySelector('#backStatus').innerText.includes('MARKET DATA READY')`);
 assert.ok(backtestInput,`Apply Best did not call the detailed backtest; status: ${await evaluate(`document.querySelector('#optStatus').textContent + '\\n' + document.querySelector('#backStatus').textContent`)}`);
 for(const key of ["emaLength","slopeLookback","entryValidCandles","rr","maxConsecutiveLosses"])assert.equal(String(backtestInput[key]),String(winningParams[key]));assert.equal(backtestInput.minStopLossDistancePct,winningParams.minStopLossDistancePct);assert.equal(backtestInput.expiryType,"WEEKLY");assert.equal(backtestInput.resolution,"1");assert.equal(backtestInput.emaSeedDate,winningConfig.emaSeedDate);
 await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 assert.equal(await evaluate(`document.documentElement.scrollWidth <= 390`),true);
 assert.equal(await evaluate(`(()=>{const l=document.querySelector('label[for="b_resolution"]').getBoundingClientRect(),s=document.querySelector('.fixed-value').getBoundingClientRect();return s.top>=l.bottom && s.width>200})()`),true);
 await writeFile(join(tmpdir(),"fyers-ui-mobile.png"),Buffer.from((await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
 console.log("Chrome smoke passed: mocked OAuth, readable responsive forms, FAST best card, exact Apply Best and auto-backtest. No live FYERS calls.");
 console.log("Screenshots: "+join(tmpdir(),"fyers-ui-desktop.png")+" and "+join(tmpdir(),"fyers-ui-mobile.png"));
}finally{if(ws)ws.close();if(chrome){chrome.kill();await once(chrome,"exit").catch(()=>{});}if(server)await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
