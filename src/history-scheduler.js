import {createHash} from "node:crypto";

const normalizedParams=value=>Object.fromEntries(Object.entries(value??{}).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,String(item)]));
const abortError = () => Object.assign(new Error("FYERS history request cancelled"), {name:"AbortError",code:"ABORT_ERR"});
const retryAfterMs = value => {
  if (!value) return null;
  const seconds=Number(value);
  if (Number.isFinite(seconds)&&seconds>=0) return seconds*1000;
  const at=Date.parse(value);
  return Number.isFinite(at)?Math.max(0,at-Date.now()):null;
};
const abortableDelay=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(abortError());
  const timer=setTimeout(done,ms);
  function done(){signal?.removeEventListener("abort",cancel);resolve();}
  function cancel(){clearTimeout(timer);signal?.removeEventListener("abort",cancel);reject(abortError());}
  signal?.addEventListener("abort",cancel,{once:true});
});
const raceAbort=(promise,signal)=>new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(abortError());
  const cancel=()=>reject(abortError());signal?.addEventListener("abort",cancel,{once:true});
  promise.then(resolve,reject).finally(()=>signal?.removeEventListener("abort",cancel));
});

/** One process-wide FIFO scheduler for every FYERS historical endpoint. */
export class HistoryRequestScheduler {
  constructor({fetchImpl=(...args)=>fetch(...args),maxConcurrent=Number(process.env.FYERS_MAX_CONCURRENT_REQUESTS??1),maxRetries=Number(process.env.FYERS_MAX_RETRIES??2),baseDelayMs=Number(process.env.FYERS_RETRY_BASE_DELAY_MS??1000),minIntervalMs=Number(process.env.FYERS_HISTORY_MIN_INTERVAL_MS??1000),cacheTtlMs=86400000,maxCacheEntries=5000,random=Math.random,delay=abortableDelay,logger=console}={}) {
    if(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||!Number.isSafeInteger(maxRetries)||maxRetries<0)throw new Error("Invalid FYERS scheduler limits");
    if(!Number.isFinite(minIntervalMs)||minIntervalMs<0)throw new Error("Invalid FYERS minimum request interval");
    this.fetchImpl=fetchImpl;this.maxConcurrent=maxConcurrent;this.maxRetries=maxRetries;this.baseDelayMs=baseDelayMs;this.minIntervalMs=minIntervalMs;this.cacheTtlMs=cacheTtlMs;this.maxCacheEntries=maxCacheEntries;this.random=random;this.delay=delay;this.logger=logger;
    this.queue=[];this.active=0;this.cache=new Map();this.inflight=new Map();this.cooldownUntil=0;this.cooldownPromise=null;this.nextRequestAt=0;
    this.counters={logicalHistoryRequests:0,logicalRequests:0,networkHistoryRequests:0,networkRequests:0,cacheHits:0,inFlightDeduplications:0,rateLimitResponses:0,retries:0,oneMinuteRequests:0,execution5sRequests:0,expiryRequests:0,optionHistoryRequests:0};
  }
  diagnostics(){return {...this.counters,queuedRequests:this.queue.length,activeRequests:this.active,maxConcurrent:this.maxConcurrent,maxRetries:this.maxRetries,minIntervalMs:this.minIntervalMs,cooldownRemainingMs:Math.max(0,this.cooldownUntil-Date.now())};}
  reset(){if(this.active||this.queue.length)throw new Error("Cannot reset FYERS scheduler while requests are active");this.cache.clear();this.inflight.clear();this.cooldownUntil=0;this.cooldownPromise=null;this.nextRequestAt=0;for(const key of Object.keys(this.counters))this.counters[key]=0;}
  request({endpoint,params,token,purpose="history",signal,onState,cacheIf=()=>true,run}){
    const isHistory=true;this.counters.logicalRequests++;if(isHistory)this.counters.logicalHistoryRequests++;
    const identity=JSON.stringify({endpoint,params:normalizedParams(params),auth:createHash("sha256").update(String(token)).digest("hex")});
    if(signal?.aborted)return Promise.reject(abortError());
    const cached=this.cache.get(identity);
    if(cached&&cached.expiresAt>Date.now()){this.counters.cacheHits++;this.#log({event:"cache_hit",endpoint,params,purpose});return Promise.resolve(cached.payload);}
    if(cached)this.cache.delete(identity);
    let entry=this.inflight.get(identity);
    if(entry){this.counters.inFlightDeduplications++;this.#log({event:"inflight_dedup",endpoint,params,purpose});}
    else {
      const controller=new AbortController();entry={identity,endpoint,params,purpose,controller,waiters:0,started:false,onState,cacheIf};
      entry.promise=new Promise((resolve,reject)=>Object.assign(entry,{resolve,reject}));
      this.inflight.set(identity,entry);this.queue.push({...entry,entry,run});
    }
    const waiter=this.#wait(entry,signal);this.#drain();return waiter;
  }
  #wait(entry,signal){
    entry.waiters++;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(fn,value)=>{if(settled)return;settled=true;signal?.removeEventListener("abort",cancel);entry.waiters--;if(entry.waiters===0&&!entry.started&&this.inflight.has(entry.identity)){entry.controller.abort();this.inflight.delete(entry.identity);this.queue=this.queue.filter(x=>x.entry!==entry);entry.reject(abortError());this.#drain();}else if(entry.waiters===0&&entry.started&&!this.cache.has(entry.identity))entry.controller.abort();fn(value);};
      const cancel=()=>finish(reject,abortError());
      signal?.addEventListener("abort",cancel,{once:true});
      entry.promise.then(value=>finish(resolve,value),error=>finish(reject,error));
    });
  }
  #log(data){if(process.env.NODE_ENV==="development")this.logger?.info?.(`[FYERS history] ${JSON.stringify(data)}`);}
  async #acquireSlot(entry,attempt,signal){
    for(;;){
      if(signal.aborted)throw abortError();
      if(this.cooldownPromise){await raceAbort(this.cooldownPromise,signal);continue;}
      const now=Date.now(),wait=Math.max(this.cooldownUntil,this.nextRequestAt)-now;
      if(wait>0){entry.onState?.({status:"waiting_rate_limit",retry:attempt,maxRetries:this.maxRetries,waitMs:wait});await this.delay(wait,signal);continue;}
      // No await between this reservation and returning: concurrent workers
      // cannot claim the same global start time.
      this.nextRequestAt=Date.now()+this.minIntervalMs;return;
    }
  }
  #drain(){while(this.active<this.maxConcurrent&&this.queue.length){const queued=this.queue.shift();if(queued.entry.controller.signal.aborted)continue;this.active++;queued.entry.started=true;this.#execute(queued).finally(()=>{this.active--;this.#drain();});}}
  async #execute({entry,run}){
    const {endpoint,params,purpose,controller,identity,cacheIf}=entry,signal=controller.signal;
    try{
      let response;
      for(let attempt=0;;attempt++){
        if(signal.aborted)throw abortError();
        await this.#acquireSlot(entry,attempt,signal);
        entry.onState?.({status:"requesting",attempt:attempt+1,maxRetries:this.maxRetries});
        const number=this.counters.networkRequests+1;this.counters.networkRequests++;this.counters.networkHistoryRequests++;
        const resolution=String(params?.resolution??""),isOption=String(purpose).toLowerCase().includes("option premium");
        if(!isOption&&resolution==="1")this.counters.oneMinuteRequests++;if(!isOption&&resolution==="5S")this.counters.execution5sRequests++;
        if(String(endpoint).toLowerCase().includes("expiry")||/expiry|contract/i.test(String(purpose)))this.counters.expiryRequests++;
        if(isOption)this.counters.optionHistoryRequests++;
        this.#log({event:"network_attempt",request:number,endpoint,params,purpose,attempt:attempt+1});
        try{response=await run(signal);}catch(error){if(signal.aborted)throw abortError();throw error;}
        this.#log({event:"response",request:number,endpoint,params,purpose,status:response.status});
        if(response.status!==429)break;
        this.counters.rateLimitResponses++;
        const header=retryAfterMs(response.headers?.get?.("retry-after"));
        const waitMs=header??Math.round(this.baseDelayMs*2**attempt*(0.75+this.random()*0.5));
        this.cooldownUntil=Math.max(this.cooldownUntil,Date.now()+waitMs);
        if(attempt>=this.maxRetries)break;
        this.counters.retries++;
        const pause=this.delay(waitMs);this.cooldownPromise=pause;
        pause.finally(()=>{if(this.cooldownPromise===pause){this.cooldownPromise=null;this.cooldownUntil=0;}}).catch(()=>{});
        this.#log({event:"rate_limited",request:number,endpoint,params,purpose,retry:attempt+1,maxRetries:this.maxRetries,retryAfterMs:header,waitMs});
        entry.onState?.({status:"waiting_rate_limit",retry:attempt+1,maxRetries:this.maxRetries,waitMs});
        // One global pause gates both this retry and every other queued worker.
        await raceAbort(pause,signal);
      }
      let result;try{result=await response.json();}catch{throw new Error(`${endpoint} returned non-JSON (HTTP ${response.status}); params=${JSON.stringify(params)}`);}
      const payload={status:response.status,ok:response.ok,body:result};
      if(response.ok&&result?.s!=="error"&&!(typeof result?.code==="number"&&result.code<0)&&cacheIf(result)){
        this.cache.delete(identity);this.cache.set(identity,{payload,expiresAt:Date.now()+this.cacheTtlMs});
        while(this.cache.size>this.maxCacheEntries)this.cache.delete(this.cache.keys().next().value);
      }
      entry.resolve(payload);
    }catch(error){entry.reject(error);}
    finally{this.inflight.delete(identity);}
  }
}

export const fyersHistoryScheduler=new HistoryRequestScheduler();
