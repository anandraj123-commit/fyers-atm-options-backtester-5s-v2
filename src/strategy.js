export function emaSeries(candles,len){
  if(len<1) throw new Error("EMA length must be >=1");
  const a=2/(len+1), out=new Array(candles.length).fill(null);
  if(!candles.length) return out;
  let e=candles[0].c; out[0]=e;
  for(let i=1;i<candles.length;i++){e=candles[i].c*a+e*(1-a);out[i]=e}
  return out;
}
export function signalAt(candles,ema,i,slopeLookback){
  if(i<slopeLookback||ema[i]==null||ema[i-slopeLookback]==null) return null;
  const x=candles[i], up=ema[i]>ema[i-slopeLookback], down=ema[i]<ema[i-slopeLookback];
  if(up && x.o<ema[i] && x.c>ema[i]) return {side:"BUY",type:"A"};
  if(up && x.o>ema[i] && x.c>ema[i] && x.l<=ema[i]) return {side:"BUY",type:"B"};
  if(down && x.o>ema[i] && x.c<ema[i]) return {side:"SELL",type:"A"};
  if(down && x.o<ema[i] && x.c<ema[i] && x.h>=ema[i]) return {side:"SELL",type:"B"};
  return null;
}