import test from "node:test";
import assert from "node:assert/strict";
import {fyersOptionCharges,CHARGE_KEYS} from "../src/charges.js";
test("all eight FYERS charges, side-specific turnover, rounded total",()=>{
 const c=fyersOptionCharges({buyPrice:100,sellPrice:120,qty:100,tradeDate:"2026-09-21"});
 assert.deepEqual(c,{brokerage:40,stt:18,exchange:7.82,clearing:1.98,sebi:.02,gst:8.97,stamp:.3,ipft:0,total:77.09});assert.ok(Math.abs(CHARGE_KEYS.reduce((s,k)=>s+c[k],0)-c.total)<1e-8);
});
test("March exchange/IPFT redistribution and April STT are date-aware",()=>{
 const charge=tradeDate=>fyersOptionCharges({buyPrice:1000,sellPrice:1000,qty:1000,tradeDate});
 const feb=charge("2026-02-28"),march=charge("2026-03-01"),april=charge("2026-04-01");
 assert.equal(feb.exchange,700.6);assert.equal(feb.ipft,10);assert.equal(march.exchange,710.6);assert.equal(march.ipft,0);assert.equal(feb.total,march.total);assert.equal(april.stt-march.stt,500);
 assert.throws(()=>charge("2024-09-30"),/unavailable/);
});
