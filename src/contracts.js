import {validDate} from "./fyers.js";
export function extractExpiryDates(resp){
  const dates=resp.data?.expiry_dates?.options;
  if(!Array.isArray(dates)) throw new Error("FYERS expiry response missing data.expiry_dates.options");
  return [...new Set(dates.map(x=>typeof x==="string"?x:x.date??x.expiry_date).filter(validDate))].sort();
}
// The live option-chain endpoint is the source of actual, not-yet-expired
// expiries. Its display date is DD-MM-YYYY and expiry is epoch seconds.
export function extractActiveExpiries(resp){
  const rows=resp.data?.expiryData;
  if(!Array.isArray(rows))throw new Error("FYERS active option-chain response missing data.expiryData");
  return rows.flatMap(row=>{
    const m=/^(\d{2})-(\d{2})-(\d{4})$/.exec(String(row.date??""));
    const date=m?`${m[3]}-${m[2]}-${m[1]}`:"",epoch=Number(row.expiry),flag=String(row.expiry_flag??"").toUpperCase();
    if(!validDate(date)||!Number.isSafeInteger(epoch)||epoch<=0||!(["D","W","M"].includes(flag)))return [];
    return [{date,epoch,type:flag==="M"?"MONTHLY":flag==="D"?"DAILY":"WEEKLY"}];
  });
}
export function extractActiveContracts(resp,expiry,expiryType,verified={}){
  const rows=resp.data?.optionsChain;
  if(!Array.isArray(rows))throw new Error("FYERS active option-chain response missing data.optionsChain");
  const out=[];
  for(const row of rows){
    const symbol=row.symbol,strike=Number(row.strike_price),optionType=String(row.option_type??"").toUpperCase();
    if(typeof symbol!=="string"||!(strike>0)||!["CE","PE"].includes(optionType))continue;
    const override=verified[symbol],lotSize=Number(row.lot_size??row.lotSize??override?.lotSize);
    out.push({symbol,strike,optionType,expiryDate:expiry,expiryType,lotSize:Number.isInteger(lotSize)&&lotSize>0?lotSize:null,
      lotSizeSource:row.lot_size!=null||row.lotSize!=null?"FYERS_ACTIVE_CONTRACT_METADATA":override?.source??"UNAVAILABLE",
      expiryTypeSource:"FYERS_ACTIVE_OPTION_CHAIN"});
  }
  return [...new Map(out.map(c=>[c.symbol,c])).values()];
}
// Decode the actual returned contract using FYERS' documented monthly/weekly symbology.
// Never strip an arbitrary trailing digit run: weekly expiry digits precede the strike.
export function decodeSymbol(symbol,expiry){
  const m=symbol.match(/^NSE:(NIFTY|BANKNIFTY)(\d{2})([A-Z]{3}|[1-9OND]\d{2})(\d+(?:\.\d+)?)(CE|PE)$/);
  if(!m||!validDate(expiry)||m[2]!==expiry.slice(2,4)) return null;
  const monthly=m[3].length===3&&/^[A-Z]+$/.test(m[3]);
  const months=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const expected=monthly?months[Number(expiry.slice(5,7))-1]:`${"123456789OND"[Number(expiry.slice(5,7))-1]}${expiry.slice(8,10)}`;
  if(m[3]!==expected) return null;
  return {strike:Number(m[4]),optionType:m[5],expiryType:monthly?"MONTHLY":"WEEKLY"};
}
export function extractContracts(resp,expiry=resp.data?.expiry_date,verified={}){
  const rows=resp.data?.contracts?.options;
  if(!Array.isArray(rows)) throw new Error("FYERS contract response missing data.contracts.options");
  const found=[];
  for(const row of rows){
    const x=typeof row==="string"?{symbol:row}:row;
    const symbol=x.symbol??x.trading_symbol??x.tradingSymbol;
    if(typeof symbol!=="string") continue;
    const decoded=decodeSymbol(symbol,expiry), override=verified[symbol];
    if(override&&(!override.source||override.expiryDate!==expiry)) throw new Error(`Verified metadata requires source and matching expiryDate for ${symbol}`);
    const strike=Number(x.strike_price??x.strikePrice??x.strike??decoded?.strike);
    const optionType=String(x.option_type??x.optType??decoded?.optionType??"").toUpperCase();
    const apiLot=x.lot_size??x.lotSize??x.minLotSize;
    const lotSize=Number(apiLot??override?.lotSize);
    const expiryType=String(x.expiry_type??x.expiryType??override?.expiryType??decoded?.expiryType??"UNKNOWN").toUpperCase();
    if(!(strike>0)||!["CE","PE"].includes(optionType)) continue;
    found.push({symbol,strike,optionType,expiryDate:expiry,expiryType,lotSize:Number.isInteger(lotSize)&&lotSize>0?lotSize:null,lotSizeSource:apiLot!=null?"FYERS_EXPIRED_CONTRACT_METADATA":override?.source??"UNAVAILABLE",expiryTypeSource:x.expiry_type||x.expiryType?"FYERS_METADATA":override?.expiryType?override.source:"FYERS_DOCUMENTED_SYMBOL_FORMAT"});
  }
  return [...new Map(found.map(c=>[c.symbol,c])).values()];
}
export function classifyExpiries(dates,contractsByExpiry=new Map()){
  // A date list alone cannot establish daily/weekly/monthly. No weekday/gap heuristic.
  return dates.flatMap(date=>[...new Set((contractsByExpiry.get(date)||[]).map(c=>c.expiryType))].map(type=>({date,type})));
}
export function chooseExpiry(classified,tradeDate,type){return classified.filter(e=>e.date>=tradeDate&&e.type===type).sort((a,b)=>a.date.localeCompare(b.date))[0]?.date??null;}
export function chooseATM(contracts,spot,optType,expiryType){return contracts.filter(x=>x.optionType===optType&&(!expiryType||x.expiryType===expiryType)).sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot)||a.strike-b.strike)[0]??null;}
