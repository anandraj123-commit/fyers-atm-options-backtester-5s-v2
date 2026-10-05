// Verified contract lot sizes from NSE circulars NSE/FAOP/61415 (02-Apr-2024),
// NSE/FAOP/64625 (18-Oct-2024), NSE/FAOP/67372 (28-Mar-2025), and
// NSE/FAOP/70616 (03-Oct-2025).
// The effective key is the actual contract expiry, not the trade date. This is
// deliberately a finite table: dates outside verified intervals fail closed.
const NSE_CIRCULAR="https://nsearchives.nseindia.com/content/circulars/FAOP70616.pdf";
const HISTORY=[
  {underlying:"NIFTY",expiryType:"WEEKLY",from:"2024-05-02",through:"2024-12-19",lotSize:25,source:"HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/61415 (https://nsearchives.nseindia.com/content/circulars/FAOP61415.pdf), revised weekly contracts from 2024-05-02; NSE/FAOP/64625 last existing-lot weekly expiry 2024-12-19"},
  {underlying:"NIFTY",expiryType:"WEEKLY",from:"2025-01-02",through:"2025-12-23",lotSize:75,source:"HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/64625 (https://nsearchives.nseindia.com/content/circulars/FAOP64625.pdf) and NSE/FAOP/70616, revised weekly expiry range 2025-01-02 through 2025-12-23"},
  {underlying:"NIFTY",expiryType:"WEEKLY",from:"2026-01-06",lotSize:65,source:`HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/70616 (${NSE_CIRCULAR}), revised weekly contracts from 2026-01-06`},
  {underlying:"NIFTY",expiryType:"MONTHLY",from:"2024-10-01",through:"2025-01-30",lotSize:25,source:"HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/64625 (https://nsearchives.nseindia.com/content/circulars/FAOP64625.pdf), existing monthly expiry lot through 2025-01-30"},
  {underlying:"NIFTY",expiryType:"MONTHLY",from:"2025-02-27",through:"2025-12-30",lotSize:75,source:"HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/64625 (https://nsearchives.nseindia.com/content/circulars/FAOP64625.pdf) and NSE/FAOP/70616, revised monthly expiry range 2025-02-27 through 2025-12-30"},
  {underlying:"NIFTY",expiryType:"MONTHLY",from:"2026-01-27",lotSize:65,source:`HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/70616 (${NSE_CIRCULAR}), revised monthly contracts from 2026-01-27`},
  {underlying:"BANKNIFTY",expiryType:"MONTHLY",from:"2024-10-01",through:"2025-01-29",lotSize:15,source:"HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/64625 (https://nsearchives.nseindia.com/content/circulars/FAOP64625.pdf), existing monthly expiry lot through 2025-01-29"},
  {underlying:"BANKNIFTY",expiryType:"MONTHLY",from:"2025-02-26",through:"2025-06-26",lotSize:30,source:"HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/67372 (https://nsearchives.nseindia.com/content/circulars/FAOP67372.pdf), prior monthly lot retained through June 2025"},
  {underlying:"BANKNIFTY",expiryType:"MONTHLY",from:"2025-07-31",through:"2025-12-30",lotSize:35,source:"HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/67372 (https://nsearchives.nseindia.com/content/circulars/FAOP67372.pdf) and NSE/FAOP/70616, revised monthly lot through 2025-12-30"},
  {underlying:"BANKNIFTY",expiryType:"MONTHLY",from:"2026-01-27",lotSize:30,source:`HISTORICAL_EXCHANGE_TABLE: NSE/FAOP/70616 (${NSE_CIRCULAR}), revised monthly contracts from 2026-01-27`}
];

export function historicalLotSize(underlying,expiryDate,expiryType){
  const row=HISTORY.find(x=>x.underlying===underlying&&x.expiryType===expiryType&&(!x.from||expiryDate>=x.from)&&(!x.through||expiryDate<=x.through));
  return row?{lotSize:row.lotSize,source:row.source}:null;
}

export function historicalLotSchedule(){return HISTORY.map(row=>({...row}));}
