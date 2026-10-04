import {buildDataset} from "../src/market.js";
import {sessionDateEpoch} from "../src/time.js";
export const day="2026-09-21",start=sessionDateEpoch(day,"09:15");
export const cfg={symbol:"NIFTY",startDate:day,endDate:day,resolution:"1",optionResolution:"1",expiryType:"WEEKLY",startingCapital:100000,lots:1,emaLength:2,slopeLookback:1,entryValidCandles:3,rr:1,maxConsecutiveLosses:2};
export const bar=(t,o=104,h=o,l=o,c=o,v=1)=>({t,o,h,l,c,v});
export function fixture({sell=false,signal=true,trigger=true,target=true,expiryType="WEEKLY",lotSize=50}={}){
  const strategy=[bar(start-120,100),bar(start-60,100),signal?(sell?bar(start,101,102,97,98):bar(start,99,103,98,102)):bar(start,100)];
  const monitor=Array.from({length:4321},(_,i)=>bar(start+i*5,sell?96:104));
  // The first future monitoring bar proves an intrabar cross. Before it, T0 is irrelevant.
  if(trigger)monitor[12]=sell?bar(start+60,98,99,96,96):bar(start+60,102,104,101,104);
  else for(let i=12;i<48;i++)monitor[i]=bar(start+i*5,100,103,97,100);
  if(target)monitor[25]=sell?bar(start+125,96,96,90,91):bar(start+125,104,110,103,109);
  const oc=Array.from({length:361},(_,i)=>bar(start+i*60,i===3?12:10));
  const contract={symbol:sell?"NSE:NIFTY2692295PE":"NSE:NIFTY26922105CE",strike:sell?95:105,optionType:sell?"PE":"CE",expiryDate:"2026-09-22",expiryType,lotSize,lotSizeSource:"FIXTURE",expiryTypeSource:"FIXTURE"};
  const data=buildDataset(strategy,monitor,{classified:[{date:"2026-09-22",type:expiryType}],contractsByExpiry:new Map([["2026-09-22",[contract]]]),getOptions:async()=>oc});
  return {data,oc,contract};
}
