import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryRequestScheduler} from '../src/history-scheduler.js';
import {backtestSpot,spotRequestCounters} from '../src/spot-engine.js';
import {optimiseSpot} from '../src/spot-optimiser.js';
import {fyersHistoryScheduler} from '../src/history-scheduler.js';
import {sessionDateEpoch} from '../src/time.js';

test('request-scoped diagnostics exclude concurrent options traffic and count cache/dedup/retries',async()=>{
 const scheduler=new HistoryRequestScheduler({minIntervalMs:0,baseDelayMs:0,maxConcurrent:2}),spot=spotRequestCounters(),other=spotRequestCounters();let release,attempts=0;
 const run=async()=>{attempts++;if(attempts===1)return new Response('{}',{status:429});await new Promise(r=>{release=r;});return new Response('{"s":"ok"}');};
 const request={endpoint:'history',params:{symbol:'NSE:NIFTY50-INDEX',resolution:'1'},token:'mock',purpose:'spot',diagnosticCounters:spot,run};const first=scheduler.request(request);const second=scheduler.request(request);
 await scheduler.request({endpoint:'option',params:{resolution:'5S'},token:'mock',purpose:'option premium',diagnosticCounters:other,run:async()=>new Response('{"s":"ok"}')});
 while(!release)await new Promise(r=>setImmediate(r));release();await Promise.all([first,second]);await scheduler.request(request);
 assert.equal(spot.networkHistoryRequests,2);assert.equal(spot.oneMinuteRequests,2);assert.equal(spot.cacheHits,1);assert.equal(spot.inFlightDeduplications,1);assert.equal(spot.rateLimitResponses,1);assert.equal(spot.retries,1);assert.equal(spot.optionHistoryRequests,0);assert.equal(spot.expiryRequests,0);assert.equal(spot.execution5sRequests,0);assert.equal(other.optionHistoryRequests,1);
});
test('real FYERS wrapper uses only resolution=1 history and reuses cached data across workflows',async t=>{
 process.env.FYERS_APP_ID='TEST-100';process.env.FYERS_SECRET_KEY='TEST_SECRET';process.env.FYERS_REDIRECT_URI='http://127.0.0.1:3000/api/fyers/callback';const before=fyersHistoryScheduler.minIntervalMs;fyersHistoryScheduler.minIntervalMs=0;fyersHistoryScheduler.reset();t.after(()=>{fyersHistoryScheduler.minIntervalMs=before;fyersHistoryScheduler.reset();});
 const day='2026-06-01',rows=[...Array.from({length:30},(_,i)=>[sessionDateEpoch('2026-05-29','14:00')+60*i,100,101,99,100,0]),...Array.from({length:360},(_,i)=>[sessionDateEpoch(day,'09:15')+60*i,100,101,99,100,0])],urls=[];
 t.mock.method(globalThis,'fetch',async url=>{urls.push(new URL(url));return new Response(JSON.stringify({s:'ok',candles:rows}));});
 const cfg={symbol:'BANKNIFTY',startDate:day,endDate:day,emaLength:2,slopeLookback:1,entryValidCandles:2,rr:2,maxConsecutiveLosses:2,minStopLossDistancePct:0};
 const back=await backtestSpot('NETWORK_FIXTURE',cfg);assert.equal(back.diagnostics.historyRequests.oneMinuteRequests,1);
 const opt=await optimiseSpot('NETWORK_FIXTURE',{...cfg,mode:'EXHAUSTIVE',emaMin:2,emaMax:3,emaStep:1,slopeMin:1,slopeMax:1,slopeStep:1,validMin:2,validMax:2,rrMin:1,rrMax:3,rrStep:1,lossMin:2,lossMax:2,stopDistanceMin:0,stopDistanceMax:0,stopDistanceStep:.1});
 assert.equal(opt.status,'complete',opt.reason);assert.equal(opt.evaluated,6);assert.equal(urls.length,1);assert.equal(opt.historyRequests.cacheHits,1);assert.equal(opt.historyRequests.networkHistoryRequests,0);
 assert.equal(urls[0].pathname,'/data/history');assert.equal(urls[0].searchParams.get('resolution'),'1');assert.equal(urls[0].searchParams.get('symbol'),'NSE:NIFTYBANK-INDEX');for(const counters of [back.diagnostics.historyRequests,opt.historyRequests])for(const key of ['execution5sRequests','expiryRequests','optionHistoryRequests'])assert.equal(counters[key],0);
});
