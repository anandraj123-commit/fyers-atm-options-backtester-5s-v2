// FYERS Standard plan, two executed NSE option orders. Sources and rounding in README.
// Earlier schedules are deliberately unsupported rather than priced at today's rates.
export const CHARGE_KEYS=["brokerage","stt","exchange","clearing","sebi","gst","stamp","ipft"];
export function fyersOptionCharges({buyPrice,sellPrice,qty,tradeDate}){
  if(tradeDate<"2024-10-01") throw new Error("Verified FYERS charge schedule unavailable before 2024-10-01");
  if(![buyPrice,sellPrice,qty].every(Number.isFinite)||buyPrice<0||sellPrice<0||qty<=0) throw new Error("Invalid option turnover for charges");
  const buy=buyPrice*qty,sell=sellPrice*qty,turnover=buy+sell;
  const brokerage=40,stt=sell*(tradeDate>="2026-04-01"?.0015:.001);
  // NSE FA73061: exchange/IPFT redistribution effective 2026-03-01.
  const exchange=turnover*(tradeDate>="2026-03-01"?.000355299:.0003503);
  const ipft=turnover*(tradeDate>="2026-03-01"?.01:50)/1e7;
  const clearing=turnover*.00009,sebi=turnover*10/1e7,stamp=buy*.00003;
  const gst=.18*(brokerage+exchange+clearing+sebi+ipft);
  const round=x=>Math.round((x+Number.EPSILON)*100)/100;
  const charges=Object.fromEntries(Object.entries({brokerage,stt,exchange,clearing,sebi,gst,stamp,ipft}).map(([k,v])=>[k,round(v)]));
  return {...charges,total:round(Object.values(charges).reduce((a,b)=>a+b,0))};
}
