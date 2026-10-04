import test from "node:test";
import assert from "node:assert/strict";
import {signalAt,emaSeries} from "../src/strategy.js";
for(const [name,x,ema]of [
 ["BUY A",{o:9,h:12,l:8,c:11},[9,10]],
 ["BUY B",{o:11,h:12,l:10,c:11},[9,10]],
 ["SELL A",{o:11,h:12,l:8,c:9},[11,10]],
 ["SELL B",{o:9,h:10,l:8,c:9},[11,10]]
])test(name,()=>assert.deepEqual(signalAt([{},x],ema,1,1),{side:name.split(" ")[0],type:name.at(-1)}));
test("EMA slope uses N completed candles, not prior candle",()=>{
 const c=[{},{},{o:9,h:12,l:8,c:11}];assert.deepEqual(signalAt(c,[8,12,10],2,2),{side:"BUY",type:"A"});assert.equal(signalAt(c,[8,12,10],2,1),null);
 assert.equal(signalAt(c,[10,12,10],2,2),null);assert.equal(signalAt(c,[8,12,10],1,2),null);
});
test("EMA recurrence and strict body comparisons",()=>{
 assert.deepEqual(emaSeries([{c:10},{c:13},{c:16}],2),[10,12,14.666666666666666]);
 assert.equal(signalAt([{}, {o:10,h:12,l:8,c:11}],[9,10],1,1),null);
});
