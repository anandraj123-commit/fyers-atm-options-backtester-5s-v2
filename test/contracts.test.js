import test from "node:test";
import assert from "node:assert/strict";
import {extractExpiryDates,extractContracts,extractActiveExpiries,extractActiveContracts,chooseATM,classifyExpiries,chooseExpiry,decodeSymbol} from "../src/contracts.js";
test("expiry parser ignores response range dates and futures-only dates",()=>{
 assert.deepEqual(extractExpiryDates({data:{from_date:"2026-09-01",to_date:"2026-10-31",expiry_dates:{futures:["2026-09-29"],options:["2026-09-22","2026-09-08","2026-09-22"]}}}),["2026-09-08","2026-09-22"]);
 assert.throws(()=>extractExpiryDates({data:{dates:["2026-09-22"]}}),/options/);
});
test("actual string contracts parse weekly strike without expiry digits and no invented lot size",()=>{
 const c=extractContracts({data:{expiry_date:"2026-09-22",contracts:{options:["NSE:NIFTY2692225500CE","NSE:NIFTY2692225600PE"]}}});
 assert.equal(c[0].strike,25500);assert.equal(c[0].lotSize,65);assert.match(c[0].lotSizeSource,/HISTORICAL_EXCHANGE_TABLE/);assert.equal(c[1].optionType,"PE");assert.equal(c[0].expiryType,"WEEKLY");assert.equal(c[0].contractRepresentation,"STRING");
 assert.equal(decodeSymbol("NSE:BANKNIFTY26SEP55000PE","2026-09-29").strike,55000);
 assert.equal(decodeSymbol("NSE:NIFTY26O0625000CE","2026-10-06").strike,25000);
 assert.equal(decodeSymbol("NSE:NIFTY2692225500CE","2026-09-29"),null);
});
test("ATM CE and PE selection, deterministic tie, actual type filtering",()=>{
 const contracts=[{strike:100,optionType:"CE",expiryType:"WEEKLY"},{strike:110,optionType:"CE",expiryType:"WEEKLY"},{strike:104,optionType:"PE",expiryType:"WEEKLY"}];
 assert.equal(chooseATM(contracts,105,"CE","WEEKLY").strike,100);assert.equal(chooseATM(contracts,105,"PE").strike,104);assert.equal(chooseATM(contracts,105,"CE","DAILY"),null);
});
test("historical metadata or explicitly sourced contract override supplies lot; no current default",()=>{
 const symbol="NSE:NIFTY2692225500CE",response={data:{expiry_date:"2026-09-22",contracts:{options:[symbol,{symbol:"NSE:NIFTY2692225500PE",lot_size:75}]}}};
 const c=extractContracts(response,"2026-09-22",{[symbol]:{lotSize:50,expiryDate:"2026-09-22",source:"archived exchange file"}});assert.equal(c[0].lotSize,50);assert.equal(c[1].lotSize,75);assert.equal(c[0].lotSizeSource,"archived exchange file");
 assert.throws(()=>extractContracts(response,"2026-09-22",{[symbol]:{lotSize:50}}),/requires source/);
});
test("FYERS explicit and nested contract lot fields win, with sanitized field provenance",()=>{
 const expiry="2026-09-15",symbol="NSE:NIFTY2691523450PE";
 const parsed=extractContracts({data:{expiry_date:expiry,contracts:{options:[{symbol,contract:{minLotSize:"66"}}]}}});
 assert.equal(parsed[0].lotSize,66);assert.equal(parsed[0].lotSizeSource,"FYERS_CONTRACT_METADATA");assert.equal(parsed[0].lotSizeMetadataField,"contract.minLotSize");assert.equal(parsed[0].lotSizeMetadataValue,"66");
});
test("NSE verified effective expiry table resolves failing NIFTY contract, independent of BANKNIFTY",()=>{
 const [nifty]=extractContracts({data:{expiry_date:"2026-09-15",contracts:{options:["NSE:NIFTY2691523450PE"]}}});
 assert.equal(nifty.lotSize,65);assert.equal(nifty.lotSizeSource.startsWith("HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/70616"),true);
 const [bank]=extractContracts({data:{expiry_date:"2026-02-24",contracts:{options:["NSE:BANKNIFTY26FEB50000PE"]}}});
 assert.equal(bank.lotSize,30);assert.notEqual(bank.lotSize,nifty.lotSize);
});
test("lot-size table follows contract expiry effective dates and fails outside verified history",()=>{
 const [old]=extractContracts({data:{expiry_date:"2025-12-23",contracts:{options:["NSE:NIFTY25D2325000CE"]}}});assert.equal(old.lotSize,75);
 const [revised]=extractContracts({data:{expiry_date:"2026-01-06",contracts:{options:["NSE:NIFTY2610625000CE"]}}});assert.equal(revised.lotSize,65);
 const [unknown]=extractContracts({data:{expiry_date:"2024-03-26",contracts:{options:["NSE:NIFTY2432625000CE"]}}});assert.equal(unknown.lotSize,null);
});
test("expiry selection uses actual contract type, no gap/weekday/substitution",()=>{
 const dates=["2026-09-21","2026-09-22","2026-09-29"],map=new Map([[dates[0],[{expiryType:"DAILY"}]],[dates[1],[{expiryType:"WEEKLY"}]],[dates[2],[{expiryType:"MONTHLY"}]]]);
 assert.deepEqual(classifyExpiries(dates),[]);
 const c=classifyExpiries(dates,map);assert.equal(chooseExpiry(c,"2026-09-21","WEEKLY"),"2026-09-22");assert.equal(chooseExpiry(c,"2026-09-21","MONTHLY"),"2026-09-29");assert.equal(chooseExpiry(c,"2026-09-21","DAILY"),"2026-09-21");assert.equal(chooseExpiry(c,"2026-09-22","DAILY"),null);
});
test("active expiry and contracts use FYERS option-chain metadata without inventing lots",()=>{
 const metadata={data:{expiryData:[{date:"08-10-2026",expiry:"1791460800",expiry_flag:"W"},{date:"29-10-2026",expiry:"1793275200",expiry_flag:"M"}]}};
 const active=extractActiveExpiries(metadata);assert.deepEqual(active.map(x=>[x.date,x.type]),[["2026-10-08","WEEKLY"],["2026-10-29","MONTHLY"]]);
 const contracts=extractActiveContracts({data:{optionsChain:[{symbol:"NSE:NIFTY26O0825000CE",strike_price:25000,option_type:"CE"},{symbol:"NSE:NIFTY26O0825000PE",strike_price:25000,option_type:"PE"}]}},"2026-10-08","WEEKLY");
 assert.equal(contracts.length,2);assert.equal(contracts[0].lotSize,65);assert.match(contracts[0].lotSizeSource,/HISTORICAL_EXCHANGE_TABLE/);assert.equal(contracts[0].expiryTypeSource,"FYERS_ACTIVE_OPTION_CHAIN");
});
