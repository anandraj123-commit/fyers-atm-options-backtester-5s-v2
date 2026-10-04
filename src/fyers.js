import crypto from "node:crypto";
import {addDays,ymdIST} from "./time.js";
import {fyersHistoryScheduler} from "./history-scheduler.js";
const DATA="https://api-t1.fyers.in/data", API="https://api-t1.fyers.in/api/v3";
// Separate allowlists: official FYERS v3 schema, verified 2026-10-04 (README sources).
const REGULAR=new Set(["5S","10S","15S","30S","45S","1","2","3","5","10","15","20","30","60","120","240","D","1D","1W","1M"]);
const EXPIRED=new Set(["5S","1","2","3","5","10","15","20","30","45","60","120","180","240"]);
const SAFE=new Set(["symbol","resolution","date_format","range_from","range_to","cont_flag","expiry_date","include_oi","include_greeks","strikecount","timestamp","greeks"]);
function cfg(){
  const appId=process.env.FYERS_APP_ID?.trim(),secret=process.env.FYERS_SECRET_KEY?.trim(),redirect=process.env.FYERS_REDIRECT_URI?.trim();
  if(!appId||!secret||!redirect) throw new Error("Missing server-side FYERS configuration");
  return {appId,secret,redirect};
}
export function redact(value,secrets=[]){
  let s=String(value);
  for(const secret of [...secrets,process.env.FYERS_SECRET_KEY].filter(Boolean)) s=s.split(secret).join("[REDACTED]");
  return s.replace(/(?:access_token|auth_code|secret|authorization|appIdHash)\s*[:=]\s*[^\s,;}]+/gi,"[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_.-]+/g,"[REDACTED]").slice(0,8000);
}
export function loginUrl(state){
  const {appId,redirect}=cfg();
  return `${API}/generate-authcode?${new URLSearchParams({client_id:appId,redirect_uri:redirect,response_type:"code",state})}`;
}
export function callbackUrl(){
  const url=new URL(cfg().redirect);
  if(!["http:","https:"].includes(url.protocol)||url.pathname!=="/api/fyers/callback"||url.search||url.hash)throw new Error("Invalid server-side FYERS callback configuration");
  return url;
}
export async function exchangeAuthCode(auth_code){
  if(typeof auth_code!=="string"||!auth_code) throw new Error("FYERS authentication: missing authorization code");
  const {appId,secret}=cfg();
  const appIdHash=crypto.createHash("sha256").update(`${appId}:${secret}`).digest("hex");
  try {
    const r=await fetch(`${API}/validate-authcode`,{method:"POST",headers:{"content-type":"application/json"},signal:AbortSignal.timeout(30000),body:JSON.stringify({grant_type:"authorization_code",appIdHash,code:auth_code})});
    const j=await r.json();
    if(!r.ok||j.s==="error"||!j.access_token) throw new Error(`FYERS authentication rejected (HTTP ${r.status})`);
    return j.access_token;
  } catch {throw new Error("FYERS authentication failed. Reconnect and check the server-side app configuration.");}
}
export function validDate(date){return typeof date==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;}
function validate(path,p,request=false){
  const schemas={"/history":["symbol","resolution","date_format","range_from","range_to"],
    "/history/fno/expired/expiry-dates":["symbol","range_from","range_to","date_format"],
    "/history/fno/expired/underlying-symbols":["symbol","expiry_date"],
    "/history/fno/expired/historical-data":["symbol","resolution","date_format","range_from","range_to"],
    "/options-chain-v3":["symbol"]};
  if(!schemas[path])throw new Error("Unknown FYERS data endpoint");
  if(request){
    for(const key of schemas[path])if(p[key]===undefined||p[key]===null||p[key]==="")throw new Error(`FYERS ${path}: missing required ${key}`);
    if(p.date_format!==undefined&&p.date_format!==1)throw new Error(`FYERS ${path}: this wrapper requires date_format=1 with ISO dates`);
    for(const key of ["cont_flag","include_oi","include_greeks"])if(p[key]!==undefined&&![0,1].includes(p[key]))throw new Error(`FYERS ${path}: ${key} must be 0 or 1`);
  }
  if(typeof p.symbol!=="string"||!/^NSE:[A-Z0-9.:-]+$/.test(p.symbol)) throw new Error(`FYERS ${path}: invalid symbol format`);
  if(p.expiry_date!==undefined&&!validDate(p.expiry_date)) throw new Error(`FYERS ${path}: expiry_date must be YYYY-MM-DD`);
  if(p.range_from!==undefined&&(!validDate(p.range_from)||!validDate(p.range_to)||p.range_from>p.range_to)) throw new Error(`FYERS ${path}: invalid YYYY-MM-DD date range`);
  if(p.resolution!==undefined&&!(path==="/history"?REGULAR:EXPIRED).has(String(p.resolution))) throw new Error(`FYERS ${path}: unsupported resolution ${p.resolution}`);
}
export async function get(path,params,token,options={}){
  validate(path,params,true);
  if(params.range_from){
    const days=(Date.parse(params.range_to)-Date.parse(params.range_from))/864e5+1;
    const limit=path.endsWith("expiry-dates")||["D","1D","1W","1M"].includes(params.resolution)?366:100;
    if(days>limit)throw new Error(`FYERS ${path}: request spans ${days} days; maximum ${limit}, split the range`);
  }
  const {appId}=cfg();
  const safe=Object.fromEntries(Object.entries(params).filter(([k])=>SAFE.has(k)));
  const context=`FYERS ${path}`;
  let r;
  try {r=await fyersHistoryScheduler.request({endpoint:`GET ${DATA}${path}`,params:safe,token,purpose:options.purpose??"history",signal:options.signal,onState:options.onState,
    cacheIf:body=>{if(path!=="/history"&&path!=="/history/fno/expired/historical-data")return true;try{parseCandles(body,params.resolution,{endpoint:`GET ${DATA}${path}`,symbol:params.symbol,resolution:params.resolution,date:params.range_from,params:safe,allowMalformedOutsideSession:path==="/history"&&String(params.resolution).endsWith("S")});return true;}catch{return false;}},
    run:async signal=>{
    const timeout=AbortSignal.timeout(30000),combined=AbortSignal.any([signal,timeout]);
    try{return await fetch(`${DATA}${path}?${new URLSearchParams(safe)}`,{headers:{Authorization:`${appId}:${token}`},signal:combined});}
    catch(error){if(signal.aborted)throw error;throw new Error(`${context} network failure (HTTP unavailable); params=${JSON.stringify(safe)}`);}
  }});}
  catch(error){if(error.name==="AbortError"||error.code==="ABORT_ERR")throw error;throw error;}
  const j=r.body;
  if(!j||typeof j!=="object")throw new Error(`FYERS API ERROR: ${context} returned an invalid response object; params=${JSON.stringify(safe)}`);
  if(!r.ok||j.s==="error"||(typeof j.code==="number"&&j.code<0)) {
    const details=Object.fromEntries(Object.entries(j.data||{}).filter(([k,v])=>SAFE.has(k)&&typeof v==="string"));
    throw new Error(`FYERS API ERROR: ${context} rejected request (HTTP ${r.status}); FYERS code=${Number.isFinite(j.code)?j.code:"unavailable"}; message=${redact(j.message||"Request rejected",[token])}; params=${JSON.stringify(safe)}; validation=${redact(JSON.stringify(details),[token])}${params.resolution?.endsWith("S")?". FYERS documents seconds history for only the last 30 trading days; no underlying fallback is allowed.":""}`);
  }
  return j;
}
const CANDLE_FIELDS=["timestamp","open","high","low","close","volume"];
const CANDLE_KEYS=["t","o","h","l","c","v"];
const COLUMN_NAMES={timestamp:["timestamp","epoch","t"],open:["open","o"],high:["high","h"],low:["low","l"],close:["close","c"],volume:["volume","v"]};
const rawText=(value,token)=>{
  let text;try{text=JSON.stringify(value);}catch{text=String(value);}
  return redact(text??String(value),token?[token]:[]).slice(0,300);
};
const numberField=value=>{
  if(typeof value!=="number"&&typeof value!=="string")return null;
  if(typeof value==="string"&&!value.trim())return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
};
function candleContext(context,resolution){
  const params=context.params??{};
  return `Endpoint: ${context.endpoint??"/history"}\nSymbol: ${context.symbol??params.symbol??"unknown"}\nResolution: ${context.resolution??resolution}\nDate: ${context.date??params.range_from??"unknown"}\nSafe request parameters: ${JSON.stringify(params)}`;
}
export function parseCandles(j,resolution,context={}){
  if(!j||typeof j!=="object"||Array.isArray(j))throw new Error(`FYERS API ERROR: malformed history response object. ${candleContext(context,resolution)}`);
  if(j.s==="error")throw new Error(`FYERS API ERROR: ${redact(j.message??"History request rejected",context.token?[context.token]:[])}; FYERS code=${Number.isFinite(j.code)?j.code:"unavailable"}. ${candleContext(context,resolution)}`);
  if(j.resolution!==undefined&&String(j.resolution)!==String(resolution))throw new Error(`FYERS API ERROR: response resolution ${j.resolution}, requested ${resolution}; refusing mislabeled data. ${candleContext(context,resolution)}`);
  const rows=j.candles??j.data?.candles;
  if(!Array.isArray(rows))throw new Error(`FYERS API ERROR: response missing candles array (actual ${rows===undefined?"undefined":typeof rows}). ${candleContext(context,resolution)}`);
  // FYERS History documents each row as [epoch seconds, open, high, low,
  // close, volume]. OI is appended only when explicitly requested; tolerate
  // additional trailing fields while parsing the documented six core fields.
  const indexes=CANDLE_FIELDS.map((name,i)=>{
    if(!Array.isArray(j.columns))return i;
    const names=j.columns.map(x=>String(x).toLowerCase());
    return names.findIndex(x=>COLUMN_NAMES[name].includes(x));
  });
  const unique=new Map(),invalid=[],ignoredOutside=[];let invalidCount=0,ignoredOutsideCount=0;
  for(let index=0;index<rows.length;index++){
    const row=rows[index],validation={},parsed={},addReason=(field,reason)=>{validation[field]=validation[field]?`${validation[field]}; ${reason}`:reason;};
    if(!Array.isArray(row)){
      validation.row=`expected FYERS candle array, received ${row===null?"null":typeof row}`;
    }else{
      for(let f=0;f<CANDLE_FIELDS.length;f++){
        const name=CANDLE_FIELDS[f],column=indexes[f],raw=column>=0?row[column]:undefined,n=numberField(raw);
        parsed[CANDLE_KEYS[f]]=n;
        if(column<0)validation[name]=`missing column (expected one of ${COLUMN_NAMES[name].join(", ")})`;
        else if(column>=row.length)validation[name]=`missing value at index ${column}; actual row length ${row.length}`;
        else if(n===null)validation[name]=`must be a finite number or numeric string; received ${raw===null?"null":raw===undefined?"undefined":JSON.stringify(raw)}`;
        else validation[name]="valid";
      }
      if(row.length<CANDLE_FIELDS.length)validation.row=`expected at least 6 fields, actual length ${row.length}`;
      const {t,o,h,l,c,v}=parsed;
      if(t!==null&&t!==undefined){
        if(!Number.isSafeInteger(t)||t<0)addReason("timestamp",`must be a non-negative integer epoch-seconds value; received ${String(row[indexes[0]])}`);
        else if(t>=1_000_000_000_000)addReason("timestamp",`appears to be milliseconds; FYERS History returns epoch seconds (${t})`);
        else {try{new Date(t*1000).toISOString();}catch{addReason("timestamp",`outside supported epoch-seconds date range (${t})`);}}
      }
      if([o,h,l,c].every(Number.isFinite)){
        if(h<l)addReason("high",`high ${h} is below low ${l}`);
        if(h<o)addReason("high",`high ${h} is below open ${o}`);
        if(h<c)addReason("high",`high ${h} is below close ${c}`);
        if(l>o)addReason("low",`low ${l} is above open ${o}`);
        if(l>c)addReason("low",`low ${l} is above close ${c}`);
      }
      if(Number.isFinite(v)&&v<0)validation.volume=`must be non-negative; received ${v}`;
      const seen=Number.isFinite(t)?unique.get(t):undefined;
      if(seen&&JSON.stringify(seen)!==JSON.stringify(parsed))addReason("timestamp",`conflicting duplicate candle timestamp ${t}`);
    }
    const reasons=Object.entries(validation).filter(([key,value])=>key==="row"||value!=="valid");
    if(reasons.length){
      let time=null;try{if(Number.isFinite(parsed.t))time=new Date((parsed.t+19800)*1000).toISOString().slice(11,19);}catch{}
      const outside=context.allowMalformedOutsideSession&&Number.isFinite(parsed.t)&&ymdIST(parsed.t)===(context.date??context.params?.range_from)&&time!==null&&(time<"09:15:00"||time>"15:15:00");
      const example={index,raw:rawText(row,context.token),length:Array.isArray(row)?row.length:"not an array",reasons};
      if(outside){ignoredOutsideCount++;if(ignoredOutside.length<5)ignoredOutside.push(example);continue;}
      invalidCount++;if(invalid.length<5)invalid.push(example);continue;
    }
    if(!unique.has(parsed.t))unique.set(parsed.t,parsed);
  }
  if(invalidCount){
    const examples=invalid.slice(0,5).map(item=>`\nCandle index: ${item.index}\nRaw candle: ${item.raw}\nExpected shape: [timestamp, open, high, low, close, volume]\nActual length: ${item.length}\nField validation: ${item.reasons.map(([field,reason])=>`${field}: ${reason}`).join("; ")}`).join("\n");
    const outsideNote=ignoredOutsideCount?`\nMalformed candles outside the requested market session were ignored: ${ignoredOutsideCount}.`:"";
    throw new Error(`INVALID FYERS CANDLE\n${candleContext(context,resolution)}\nInvalid candles: ${invalidCount}; showing ${Math.min(invalidCount,5)} (maximum 5). First invalid candle:${examples}${outsideNote}`);
  }
  if(ignoredOutsideCount)context.onInvalidOutsideSession?.({count:ignoredOutsideCount,examples:ignoredOutside});
  return [...unique.values()].sort((a,b)=>a.t-b.t);
}
export function historyRequest(symbol,resolution,from,to){
  validate("/history",{symbol,resolution,range_from:from,range_to:to});
  return {symbol,resolution,date_format:1,range_from:from,range_to:to,cont_flag:0};
}
export async function history(token,symbol,resolution,from,to,options={}){
  validate("/history",{symbol,resolution,range_from:from,range_to:to});
  const out=[];let invalidOutsideSessionCount=0;
  // One day for seconds avoids oversized responses; minute history <=100 days/request.
  // 1m requests use the API's documented broad range limit; 5S uses small
  // bounded multi-session chunks to keep payloads manageable without one call
  // per calendar day.
  const days=String(resolution).endsWith("S")?5:100;
  for(let d=from;d<=to;d=addDays(d,days)){
    const end=addDays(d,days-1)<to?addDays(d,days-1):to;
    const params=historyRequest(symbol,resolution,d,end);
    const onInvalidOutsideSession=details=>{invalidOutsideSessionCount+=details.count;options.onInvalidOutsideSession?.(details);if(!options.onInvalidOutsideSession&&process.env.NODE_ENV!=="production")console.warn(`FYERS ignored ${details.count} malformed pre/post-session candle(s) outside the required trading window: ${JSON.stringify({endpoint:"GET /data/history",symbol,resolution,date:d,examples:details.examples})}`);};
    out.push(...parseCandles(await get("/history",params,token,{...options,purpose:options.purpose??`underlying ${resolution}`} ),resolution,{endpoint:"GET /data/history",symbol,resolution,date:d,params,token,
      allowMalformedOutsideSession:String(resolution).endsWith("S"),onInvalidOutsideSession}));
  }
  Object.defineProperty(out,"diagnostics",{value:{invalidOutsideSessionCount},enumerable:false});
  return out;
}
export async function expiryDates(token,symbol,from,to,options={}){
  const today=ymdIST(Date.now()/1000);
  if(to>=today)throw new Error(`FYERS expired expiry-dates endpoint accepts expired dates only; refusing range_to=${to} (today IST=${today})`);
  return get("/history/fno/expired/expiry-dates",{symbol,range_from:from,range_to:to,date_format:1},token,{...options,purpose:options.purpose??"expiry dates"});
}
export async function optionChain(token,symbol,expiryEpoch,options={}){
  if(expiryEpoch&&typeof expiryEpoch==="object"){options=expiryEpoch;expiryEpoch=undefined;}
  const params={symbol,strikecount:50};if(expiryEpoch!==undefined)params.timestamp=String(expiryEpoch);
  return get("/options-chain-v3",params,token,{...options,purpose:options.purpose??"active option contracts"});
}
export async function expiredSymbols(token,symbol,expiry,options={}){
  if(expiry>=ymdIST(Date.now()/1000))throw new Error(`FYERS expired contracts endpoint requires an expired expiry date; refusing expiry_date=${expiry}`);
  return get("/history/fno/expired/underlying-symbols",{symbol,expiry_date:expiry},token,{...options,purpose:options.purpose??"expired option contracts"});
}
export async function expiredHistory(token,symbol,resolution,from,to,options={}){
  if(to>=ymdIST(Date.now()/1000))throw new Error(`FYERS expired history endpoint requires expired contracts and past dates; refusing range_to=${to}`);
  const params={symbol,resolution,date_format:1,range_from:from,range_to:to,include_greeks:0,include_oi:0};
  return parseCandles(await get("/history/fno/expired/historical-data",params,token,{...options,purpose:options.purpose??"expired option premium"}),resolution,{endpoint:"GET /history/fno/expired/historical-data",symbol,resolution,date:from,params,token});
}
export async function activeOptionHistory(token,symbol,resolution,from,to,options={}){
  return history(token,symbol,resolution,from,to,{...options,purpose:options.purpose??"active option premium"});
}
export const historyRequestDiagnostics=()=>fyersHistoryScheduler.diagnostics();
export const resetHistoryRequestDiagnostics=()=>fyersHistoryScheduler.reset();
