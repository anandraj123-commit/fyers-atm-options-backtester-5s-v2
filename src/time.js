export const IST_OFFSET = 19800;
export function ymdIST(epoch) {
  return new Date((epoch + IST_OFFSET) * 1000).toISOString().slice(0,10);
}
export function hmIST(epoch) {
  return new Date((epoch + IST_OFFSET) * 1000).toISOString().slice(11,16);
}
export function weekdayIST(epoch) {
  return new Date((epoch + IST_OFFSET) * 1000).getUTCDay();
}
export function inSession(epoch) {
  const d=weekdayIST(epoch), hm=hmIST(epoch);
  return d>=1 && d<=5 && hm>="09:15" && hm<="15:15";
}
export function sessionDateEpoch(date, hhmm="09:15") {
  return Math.floor(new Date(`${date}T${hhmm}:00+05:30`).getTime()/1000);
}
export function addDays(date,n){
  const d=new Date(date+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+n);
  return d.toISOString().slice(0,10);
}