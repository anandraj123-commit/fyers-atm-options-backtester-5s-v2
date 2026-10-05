import express from "express";
import crypto from "node:crypto";
import {pathToFileURL,fileURLToPath} from "node:url";
import {loginUrl,callbackUrl,exchangeAuthCode,history as fyersHistory,historyRequest,historyRequestDiagnostics,validDate,redact} from "./fyers.js";
import {backtest,normalize} from "./engine.js";
import {optimise,searchPlan} from "./optimiser.js";
import {clearMarketStores} from "./market.js";
import {SYMBOLS} from "./market.js";
const BUILD_MARKER="4.3.0 | fixed=1m/5S/WEEKLY | optimiser=FAST/EXHAUSTIVE-streaming | fyers-history=scheduled-paced-cached-deduplicated";
export function createApp(deps={}){
  const app=express(),jobs=new Map(),states=new Map();let accessToken=deps.token??null,backtestWait=null,backtestProgress=null;
  const updateBacktestProgress=event=>{
    if(!backtestProgress)backtestProgress={status:"preparing_data",stages:{},activeStage:null,currentActivity:"Preparing historical market data",overallPercentage:null};
    const stage=event.stage,previous=backtestProgress.stages[stage]??{stage,status:"waiting",completed:0,total:null,percentage:null};
    const unit=event.unit??"units",priorWork=previous.work?.[unit]??{completed:0,total:null,percentage:null};
    const completed=Number.isFinite(event.completed)?event.completed:priorWork.completed,total=event.total===undefined?priorWork.total:Number.isFinite(event.total)?event.total:null;
    const percentage=total>0?Math.max(0,Math.min(100,Math.floor(completed/total*100))):null;
    const work={...(previous.work??{}),[unit]:{unit,completed,total,percentage}};
    backtestProgress.stages[stage]={...previous,...event,work,unit,completed,total,percentage};
    if(event.status!=="complete")backtestProgress.activeStage=stage;
    else if(backtestProgress.activeStage===stage)backtestProgress.activeStage=null;
    backtestProgress.status=event.status==="waiting_rate_limit"?"waiting_rate_limit":"preparing_data";
    if(event.activity)backtestProgress.currentActivity=redact(String(event.activity),[accessToken]);
    backtestProgress.overallPercentage=null;
  };
  function connected(){
    if(accessToken){
      // Expiry is only used to discard an already server-obtained token, never to
      // accept a client-supplied JWT as authentication. Opaque tokens stay private.
      try{const payload=JSON.parse(Buffer.from(accessToken.split(".")[1],"base64url"));if(Number.isFinite(payload.exp)&&payload.exp*1000<=Date.now())accessToken=null;}catch{}
    }
    return !!accessToken;
  }
  app.disable("x-powered-by");
  app.use((req,res,next)=>{res.set({"Referrer-Policy":"no-referrer","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});if(req.method==="POST"&&req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return res.status(403).json({error:"Cross-origin request rejected"});next();});
  app.use(express.json({limit:"1mb"}));app.use(express.static(fileURLToPath(new URL("../public/",import.meta.url))));
  const requireToken=()=>{if(!connected())throw new Error("Connect FYERS first.");return accessToken;};
  const run=async(res,fn)=>{try{res.json(await fn());}catch(e){res.status(400).json({error:redact(e.message,[accessToken])});}};
  app.get("/api/status",(req,res)=>res.json({connected:connected(),build:BUILD_MARKER,marketDataWait:backtestWait,marketDataProgress:backtestProgress,historyRequests:historyRequestDiagnostics()}));
  app.get("/api/debug/fyers-history",async(req,res)=>{
    if(process.env.NODE_ENV==="production")return res.status(404).json({error:"Not found"});
    try{
      const token=requireToken(),symbolName=String(req.query.symbol??""),date=String(req.query.date??""),resolution=String(req.query.resolution??"");
      if(!SYMBOLS[symbolName])throw new Error("symbol must be NIFTY or BANKNIFTY");
      if(!validDate(date))throw new Error("date must be a valid YYYY-MM-DD date");
      if(resolution!=="5S")throw new Error("resolution must be 5S; this diagnostic does not offer a fallback");
      const symbol=SYMBOLS[symbolName],params=historyRequest(symbol,resolution,date,date);
      const candles=await (deps.history??fyersHistory)(token,symbol,resolution,date,date);
      return res.json({endpoint:"GET /data/history",symbol,resolution,date,params,candleCount:candles.length,firstCandle:candles[0]??null,lastCandle:candles.at(-1)??null,invalidCount:0,invalidOutsideSessionCount:candles.diagnostics?.invalidOutsideSessionCount??0,availabilityNote:candles.length?"FYERS returned candles for this request.":"No candles were returned. This may indicate no data or an unavailable historical date; the API response must distinguish the cause."});
    }catch(error){return res.status(400).json({error:redact(error.message,[accessToken])});}
  });
  app.get("/api/debug/fyers-requests",(req,res)=>{
    if(process.env.NODE_ENV==="production")return res.status(404).json({error:"Not found"});
    try{requireToken();return res.json(historyRequestDiagnostics());}
    catch(error){return res.status(400).json({error:redact(error.message,[accessToken])});}
  });
  app.get("/api/fyers/login",(req,res)=>{
    try{
      const callback=(deps.callbackUrl??callbackUrl)();
      // localhost and 127.0.0.1 do not share cookies. Start on the callback origin
      // before issuing state, so the provider's return can validate that cookie.
      if(`${req.protocol}://${req.headers.host}`!==callback.origin)return res.redirect(new URL("/api/fyers/login",callback.origin).href);
      for(const [k,expiry]of states)if(expiry<Date.now())states.delete(k);
      const state=crypto.randomBytes(24).toString("hex");states.set(state,Date.now()+600000);
      res.cookie("fyers_oauth_state",state,{httpOnly:true,sameSite:"lax",secure:callback.protocol==="https:",maxAge:600000,path:callback.pathname});
      res.redirect((deps.loginUrl??loginUrl)(state));
    }catch{res.redirect("/?auth=failed");}
  });
  app.get("/api/fyers/callback",async(req,res)=>{
    try{
      const cookie=req.headers.cookie?.match(/(?:^|;\s*)fyers_oauth_state=([a-f0-9]+)/)?.[1],state=req.query.state;
      if(typeof state!=="string"||cookie!==state||(states.get(state)??0)<Date.now())throw new Error("Invalid OAuth state");
      states.delete(state);
      const token=await (deps.exchangeAuthCode??exchangeAuthCode)(req.query.auth_code);
      if(typeof token!=="string"||!token)throw new Error("Authentication did not return a token");
      accessToken=token;clearMarketStores();
      res.clearCookie("fyers_oauth_state",{path:"/api/fyers/callback"});res.redirect("/?connected=1");
    }catch{res.clearCookie("fyers_oauth_state",{path:"/api/fyers/callback"});res.redirect("/?auth=failed");}
  });
  app.post("/api/backtest",async(req,res)=>{
    const controller=new AbortController();res.on("close",()=>{if(!res.writableEnded)controller.abort();});
    try{backtestProgress={status:"preparing_data",stages:{},activeStage:null,currentActivity:"Preparing historical market data",overallPercentage:null};const result=await (deps.backtest??backtest)(requireToken(),normalize(req.body),{signal:controller.signal,onPreparationProgress:updateBacktestProgress,onProgress:message=>{if(backtestProgress)backtestProgress.currentActivity=redact(String(message),[accessToken]);},onDataStatus:status=>{backtestWait=status.status==="waiting_rate_limit"?{retry:status.retry,maxRetries:status.maxRetries,waitMs:status.waitMs}:null;if(backtestProgress?.activeStage){const stage=backtestProgress.stages[backtestProgress.activeStage];if(backtestWait){stage.status="waiting_rate_limit";stage.retry=backtestWait.retry;stage.maxRetries=backtestWait.maxRetries;stage.waitMs=backtestWait.waitMs;stage.activity=`Waiting before retry — ${backtestProgress.currentActivity}`;backtestProgress.status="waiting_rate_limit";}else if(status.status==="requesting"||backtestProgress.status==="waiting_rate_limit"){stage.status="fetching";delete stage.retry;delete stage.maxRetries;delete stage.waitMs;backtestProgress.status="preparing_data";}}}});if(!res.writableEnded)res.json(result);}
    catch(error){if(res.writableEnded)return;const prep=error.code==="MARKET_DATA_PREPARATION",message=redact(error.message,[accessToken]);if(backtestProgress){backtestProgress.status="failed";const stage=backtestProgress.stages[backtestProgress.activeStage];if(stage){stage.status="failed";stage.activity="Preparation failed";}}
      res.status(prep?503:400).json(prep?{status:"failed",phase:"preparing_data",incompleteData:true,pipelineCounters:error.pipelineCounters??null,marketData:error.marketData??null,error:`BACKTEST NOT RUN\nRequired market data could not be prepared.\n${message}`}:{error:message});}
    finally{backtestWait=null;backtestProgress=null;}
  });
  app.post("/api/optimise",(req,res)=>run(res,async()=>{
    const token=requireToken(),cfg=normalize(req.body,true),plan=searchPlan(cfg);
    if([...jobs.values()].some(j=>["queued","preparing","preparing_data","waiting_rate_limit","running","sorting"].includes(j.state.status)))throw new Error("An optimisation is already running; cancel it before starting another");
    const id=crypto.randomUUID(),controller=new AbortController(),job={controller,state:{id,jobId:id,status:"queued",mode:cfg.mode,stage:"Queued",requested:plan.totalCombinations,totalCombinations:plan.totalCombinations,evaluated:0,processed:0,storedResults:0,materialisedRows:0,elapsed:0,elapsedSeconds:0,progressPct:0,bestResult:null},store:null};jobs.set(id,job);
    setImmediate(async()=>{
      try{
        const safeState=state=>({...state,...(state.reason?{reason:redact(state.reason,[token])}:{}),...(state.message?{message:redact(state.message,[token])}:{})});
        const trustedState=state=>({...safeState(state),mode:cfg.mode,resolution:cfg.resolution,requested:plan.totalCombinations,totalCombinations:plan.totalCombinations});
        const result=await (deps.optimise??optimise)(token,cfg,{signal:controller.signal,onStore:store=>{job.store=store;},onProgress:state=>{job.state={id,jobId:id,...trustedState(state),status:state.sorting?"sorting":state.status};}});
        const {store,...state}=result;job.store=store??job.store;
        // A FAST implementation that returns without doing work must never be
        // presented as complete. This also makes stale/incorrect implementations
        // visible as a failed job with the already validated requested count.
        if(state.status==="complete"&&state.mode==="FAST"&&(Number(state.evaluated??state.processed??0)<1||!state.bestResult)){
          state.status="failed";state.exhaustive=false;
          state.reason??="FAST search ended before producing an evaluated candidate and a best result.";
        }
        job.state={id,jobId:id,...trustedState(state)};
      }catch(e){job.state={...job.state,status:job.state.evaluated?"incomplete":"failed",reason:redact(e.message,[token]),exhaustive:false};}
    });
    return {id,jobId:id,mode:cfg.mode,status:"queued",requested:plan.totalCombinations};
  }));
  function getJob(id){requireToken();const job=jobs.get(id);if(!job)throw new Error("Unknown optimisation job");return job;}
  app.get("/api/optimise/:id",(req,res)=>run(res,()=>getJob(req.params.id).state));
  app.post("/api/optimise/:id/cancel",(req,res)=>run(res,()=>{const j=getJob(req.params.id);j.controller.abort();return {cancellationRequested:true};}));
  app.get("/api/optimise/:id/results",(req,res)=>run(res,()=>{const j=getJob(req.params.id);if(!j.store)throw new Error("No result rows available");return j.store.page(Number(req.query.page??0));}));
  app.get("/api/optimise/:id/export",(req,res)=>{
    try{const j=getJob(req.params.id);if(!j.store?.file)throw new Error("Results are not ready for export");res.download(j.store.file,"optimisation-results.ndjson");}
    catch(e){res.status(400).json({error:redact(e.message,[accessToken])});}
  });
  app.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(400).json({error:"Invalid request"});});
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.PORT||3000);createApp().listen(port,"127.0.0.1",()=>{
    console.log(`FYERS Backtester build: ${BUILD_MARKER}`);
    console.log(`Source: ${fileURLToPath(import.meta.url)}`);
    console.log(`Open http://127.0.0.1:${port}`);
  });
}
