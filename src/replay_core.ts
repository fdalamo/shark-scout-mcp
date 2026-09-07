export const WSOL="So11111111111111111111111111111111111111112";
export const USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT="Es9vMFrzaCERmFfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const NATIVE_SOL="SOL";

// Helius Enhanced/API variants have used both the canonical USDT mint and older
// typo-prone copies in downstream code. Keep only real mints here; callers should
// never silently treat an unknown token as a quote asset.
export const QUOTE_MINTS=new Set([WSOL,USDC,USDT]);

export type Quote={mint:string;amount:number};
export type TradeSide="BUY"|"SELL";
export type Evidence="account_delta"|"event_fallback";
export type Confidence="HIGH"|"MEDIUM"|"LOW";

export type ClassifiedTrade={
  side:TradeSide;
  mint:string;
  qty:number;
  quote:Quote|null;
  evidence:Evidence;
  confidence:Confidence;
  signature:string;
  timestamp:number;
  flags:string[];
};

export type ReplayTrade={
  mint:string;
  buySignature:string;
  sellSignature:string;
  buyTimestamp:number;
  sellTimestamp:number;
  holdSeconds:number;
  qty:number;
  buyQuote:Quote|null;
  sellQuote:Quote|null;
  sourceRoi:number|null;
  followerNetSol:number|null;
  followerRoi:number|null;
  stress50NetSol:number|null;
  stress75NetSol:number|null;
  evidence:string;
  trusted:boolean;
  flags:string[];
};

export type ReplayDiagnostics={
  swapLike:number;
  classified:number;
  accountDelta:number;
  eventFallbacks:number;
  ambiguous:number;
  ambiguousReasons:Record<string,number>;
  tokenToToken:number;
  unmatchedSells:number;
  quoteMismatch:number;
  economicOutliers:number;
};

export type ReplayResult={
  roundTrips:ReplayTrade[];
  raw:{trades:number;netSol:number|null;stress50NetSol:number|null;winRate:number|null;medianRoi:number|null;largestWinnerShare:number|null};
  trusted:{trades:number;netSol:number|null;stress50NetSol:number|null;winRate:number|null;medianRoi:number|null;largestWinnerShare:number|null};
  diagnostics:ReplayDiagnostics;
};

const FOLLOW_SIZE=.075,ODIN_RATE=.01,TIP_RATE=.003,NETWORK_PER_LEG=.00015;
const MIN_SOL_QUOTE=.0003,MIN_STABLE_QUOTE=.03;
// A 250x source return (+25,000%) can be real in memecoins, but it is too extreme
// to trust from one parser path without corroboration. Preserve it in raw output,
// quarantine it from trusted replay, and surface the signature for investigation.
const MAX_UNCORROBORATED_ROI=250;

type Lot={t:number;qty:number;quote:Quote|null;signature:string;evidence:Evidence;flags:string[]};

function n(v:any):number|null{const x=Number(v);return Number.isFinite(x)?x:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
function median(xs:number[]){if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;}
function canonicalQuote(mint:string){return mint===WSOL||mint===NATIVE_SOL?NATIVE_SOL:mint;}
function sameQuote(a:Quote|null,b:Quote|null){return Boolean(a&&b&&canonicalQuote(a.mint)===canonicalQuote(b.mint));}
function inc(o:Record<string,number>,k:string){o[k]=(o[k]||0)+1;}

function decimalRawToNumber(raw:any,decimals:any):number|null{
  if(raw==null)return null;
  const d=n(decimals);
  if(d==null||d<0||d>30)return n(raw);
  const s=String(raw);
  if(!/^-?\d+$/.test(s)){
    const x=n(raw);return x==null?null:x/10**d;
  }
  const neg=s.startsWith("-"),digits=neg?s.slice(1):s;
  const padded=digits.padStart(d+1,"0"),i=padded.length-d;
  const ui=Number(`${neg?"-":""}${padded.slice(0,i)}${d?"."+padded.slice(i):""}`);
  return Number.isFinite(ui)?ui:null;
}

function amountFromChange(x:any):number|null{
  const rawObj=x?.rawTokenAmount;
  if(rawObj&&rawObj.tokenAmount!=null){
    const z=decimalRawToNumber(rawObj.tokenAmount,rawObj.decimals);if(z!=null)return z;
  }
  if(x?.tokenAmount!=null){
    // Helius tokenBalanceChanges commonly exposes UI tokenAmount here.
    const z=n(x.tokenAmount);if(z!=null)return z;
  }
  return null;
}

function amountFromEvent(x:any):number|null{
  const rawObj=x?.rawTokenAmount;
  if(rawObj&&rawObj.tokenAmount!=null){const z=decimalRawToNumber(rawObj.tokenAmount,rawObj.decimals);if(z!=null)return z;}
  return n(x?.tokenAmount);
}

function feeAdjustedNative(tx:any,wallet:string){
  let delta=0,seen=false;
  for(const ad of tx?.accountData||[]){if(ad?.account!==wallet)continue;const d=n(ad?.nativeBalanceChange);if(d!=null){delta+=d/1e9;seen=true;}}
  // nativeBalanceChange includes transaction fee. Remove it only when we can prove
  // this wallet paid it; otherwise leave the observed delta untouched.
  const payer=String(tx?.feePayer||tx?.fee_payer||"");
  const fee=n(tx?.fee);
  if(seen&&payer===wallet&&fee!=null&&fee>0)delta+=fee/1e9;
  return seen?delta:null;
}

function accountDeltas(tx:any,wallet:string){
  const token=new Map<string,number>();let changes=0;
  for(const ad of tx?.accountData||[]){
    for(const tb of ad?.tokenBalanceChanges||[]){
      if(tb?.userAccount!==wallet||!tb?.mint)continue;
      const q=amountFromChange(tb);if(q==null||Math.abs(q)<1e-18)continue;
      token.set(String(tb.mint),(token.get(String(tb.mint))||0)+q);changes++;
    }
  }
  return{token,native:feeAdjustedNative(tx,wallet),changes};
}

function quoteDeltas(d:{token:Map<string,number>;native:number|null}){
  const m=new Map<string,number>();
  const sol=(d.native||0)+(d.token.get(WSOL)||0);if(Math.abs(sol)>1e-12)m.set(NATIVE_SOL,sol);
  for(const q of [USDC,USDT]){const x=d.token.get(q)||0;if(Math.abs(x)>1e-12)m.set(q,x);}
  return m;
}
function materialQuoteEntries(q:Map<string,number>,sign:1|-1){
  return [...q].filter(([mint,v])=>sign*v>(mint===NATIVE_SOL?MIN_SOL_QUOTE:MIN_STABLE_QUOTE));
}

function eventFallback(tx:any,wallet:string):ClassifiedTrade|null{
  const ev=tx?.events?.swap;if(!ev)return null;
  const pos=new Map<string,number>(),neg=new Map<string,number>();
  for(const x of ev?.tokenOutputs||[]){if(x?.userAccount!==wallet||!x?.mint)continue;const q=amountFromEvent(x);if(q!=null&&q>0)pos.set(String(x.mint),(pos.get(String(x.mint))||0)+q);}
  for(const x of ev?.tokenInputs||[]){if(x?.userAccount!==wallet||!x?.mint)continue;const q=amountFromEvent(x);if(q!=null&&q>0)neg.set(String(x.mint),(neg.get(String(x.mint))||0)+q);}
  const ni=n(ev?.nativeInput?.amount),no=n(ev?.nativeOutput?.amount);
  if(ni!=null&&ni>0)neg.set(NATIVE_SOL,(neg.get(NATIVE_SOL)||0)+ni/1e9);
  if(no!=null&&no>0)pos.set(NATIVE_SOL,(pos.get(NATIVE_SOL)||0)+no/1e9);
  const nonQIn=[...pos].filter(([m])=>m!==NATIVE_SOL&&!QUOTE_MINTS.has(m));
  const nonQOut=[...neg].filter(([m])=>m!==NATIVE_SOL&&!QUOTE_MINTS.has(m));
  const qSpent=[...neg].filter(([m,v])=>(m===NATIVE_SOL||QUOTE_MINTS.has(m))&&v>(m===NATIVE_SOL?MIN_SOL_QUOTE:MIN_STABLE_QUOTE));
  const qRecv=[...pos].filter(([m,v])=>(m===NATIVE_SOL||QUOTE_MINTS.has(m))&&v>(m===NATIVE_SOL?MIN_SOL_QUOTE:MIN_STABLE_QUOTE));
  const sig=String(tx?.signature||""),timestamp=Number(tx?.timestamp||0);
  if(nonQIn.length===1&&nonQOut.length===0&&qSpent.length===1){const [mint,qty]=nonQIn[0]!,[qm,qa]=qSpent[0]!;return{side:"BUY",mint,qty,quote:{mint:canonicalQuote(qm),amount:qa},evidence:"event_fallback",confidence:"MEDIUM",signature:sig,timestamp,flags:["EVENT_FALLBACK"]};}
  if(nonQOut.length===1&&nonQIn.length===0&&qRecv.length===1){const [mint,qty]=nonQOut[0]!,[qm,qa]=qRecv[0]!;return{side:"SELL",mint,qty,quote:{mint:canonicalQuote(qm),amount:qa},evidence:"event_fallback",confidence:"MEDIUM",signature:sig,timestamp,flags:["EVENT_FALLBACK"]};}
  return null;
}

export function classifyEnhancedTransaction(tx:any,wallet:string):{trade:ClassifiedTrade|null;reason:string|null;tokenToToken:boolean}{
  const swapLike=String(tx?.type||"").toUpperCase()==="SWAP"||Boolean(tx?.events?.swap);if(!swapLike)return{trade:null,reason:"NOT_SWAP",tokenToToken:false};
  if(tx?.transactionError||tx?.error)return{trade:null,reason:"FAILED_TX",tokenToToken:false};
  const d=accountDeltas(tx,wallet),pos:[string,number][]=[],neg:[string,number][]=[];
  for(const [mint,q] of d.token){if(QUOTE_MINTS.has(mint)||Math.abs(q)<1e-18)continue;(q>0?pos:neg).push([mint,Math.abs(q)]);}
  const qd=quoteDeltas(d),spent=materialQuoteEntries(qd,-1),recv=materialQuoteEntries(qd,1);
  const sig=String(tx?.signature||""),timestamp=Number(tx?.timestamp||0);
  if(pos.length===1&&neg.length===0&&spent.length===1&&recv.length===0){const [mint,qty]=pos[0]!,[qm,delta]=spent[0]!;return{trade:{side:"BUY",mint,qty,quote:{mint:canonicalQuote(qm),amount:Math.abs(delta)},evidence:"account_delta",confidence:"HIGH",signature:sig,timestamp,flags:[]},reason:null,tokenToToken:false};}
  if(neg.length===1&&pos.length===0&&recv.length===1&&spent.length===0){const [mint,qty]=neg[0]!,[qm,delta]=recv[0]!;return{trade:{side:"SELL",mint,qty,quote:{mint:canonicalQuote(qm),amount:Math.abs(delta)},evidence:"account_delta",confidence:"HIGH",signature:sig,timestamp,flags:[]},reason:null,tokenToToken:false};}
  const tokenToToken=pos.length>0&&neg.length>0&&spent.length===0&&recv.length===0;
  if(tokenToToken)return{trade:null,reason:"TOKEN_TO_TOKEN_NO_EXACT_QUOTE",tokenToToken:true};
  const fb=eventFallback(tx,wallet);if(fb)return{trade:fb,reason:null,tokenToToken:false};
  let reason="AMBIGUOUS";
  if(pos.length+neg.length===0)reason="NO_NONQUOTE_DELTA";
  else if(spent.length+recv.length===0)reason="NO_QUOTE_DELTA";
  else if(spent.length+recv.length>1)reason="MULTIPLE_QUOTE_DELTAS";
  else if(pos.length+neg.length>1)reason="MULTIPLE_NONQUOTE_DELTAS";
  return{trade:null,reason,tokenToToken:false};
}

function econ(sourceRoi:number|null,retention=1){
  if(sourceRoi==null||!Number.isFinite(sourceRoi)||sourceRoi<=-1)return{net:null,roi:null};
  const bf=Math.max(FOLLOW_SIZE*ODIN_RATE,.001),bt=FOLLOW_SIZE*TIP_RATE,cost=FOLLOW_SIZE+bf+bt+NETWORK_PER_LEG;
  const gross=Math.max(0,FOLLOW_SIZE*(1+sourceRoi*retention)),sf=Math.max(gross*ODIN_RATE,.001),st=gross*TIP_RATE;
  const net=gross-sf-st-NETWORK_PER_LEG-cost;return{net,roi:net/cost};
}

function summarize(trades:ReplayTrade[],trustedOnly:boolean){
  const xs=trustedOnly?trades.filter(x=>x.trusted):trades.filter(x=>x.followerNetSol!=null);
  const nets=xs.map(x=>x.followerNetSol).filter((x):x is number=>x!=null),s50=xs.map(x=>x.stress50NetSol).filter((x):x is number=>x!=null),rois=xs.map(x=>x.followerRoi).filter((x):x is number=>x!=null),wins=nets.filter(x=>x>0);
  const grossWin=sum(wins),largest=wins.length?Math.max(...wins):0;
  return{trades:nets.length,netSol:nets.length?sum(nets):null,stress50NetSol:s50.length?sum(s50):null,winRate:nets.length?wins.length/nets.length:null,medianRoi:median(rois),largestWinnerShare:grossWin>0?largest/grossWin:null};
}

export function replayEnhancedRows(rows:any[],wallet:string):ReplayResult{
  const ordered=[...rows].filter(x=>Number.isFinite(Number(x?.timestamp))).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp));
  const open=new Map<string,Lot[]>(),rts:ReplayTrade[]=[];
  const diagnostics:ReplayDiagnostics={swapLike:0,classified:0,accountDelta:0,eventFallbacks:0,ambiguous:0,ambiguousReasons:{},tokenToToken:0,unmatchedSells:0,quoteMismatch:0,economicOutliers:0};
  for(const tx of ordered){
    const isSwap=String(tx?.type||"").toUpperCase()==="SWAP"||Boolean(tx?.events?.swap);if(!isSwap)continue;diagnostics.swapLike++;
    const c=classifyEnhancedTransaction(tx,wallet);if(!c.trade){if(c.tokenToToken)diagnostics.tokenToToken++;else{diagnostics.ambiguous++;inc(diagnostics.ambiguousReasons,c.reason||"UNKNOWN");}continue;}
    const ex=c.trade;diagnostics.classified++;if(ex.evidence==="account_delta")diagnostics.accountDelta++;else diagnostics.eventFallbacks++;
    if(ex.side==="BUY"){const a=open.get(ex.mint)||[];a.push({t:ex.timestamp,qty:ex.qty,quote:ex.quote,signature:ex.signature,evidence:ex.evidence,flags:[...ex.flags]});open.set(ex.mint,a);continue;}
    const a=open.get(ex.mint)||[];let remaining=ex.qty,totalQty=ex.qty;
    if(!a.length){diagnostics.unmatchedSells++;continue;}
    while(a.length&&remaining>1e-18){
      const lot=a[0]!,take=Math.min(remaining,lot.qty),buyFrac=take/lot.qty,sellFrac=totalQty>0?take/totalQty:0;
      const buyQuote=lot.quote?{...lot.quote,amount:lot.quote.amount*buyFrac}:null,sellQuote=ex.quote?{...ex.quote,amount:ex.quote.amount*sellFrac}:null;
      const flags=[...lot.flags,...ex.flags];let src:number|null=null,trusted=true;
      if(!sameQuote(buyQuote,sellQuote)){flags.push("QUOTE_MISMATCH_OR_UNKNOWN");diagnostics.quoteMismatch++;trusted=false;}
      else if(buyQuote&&sellQuote&&buyQuote.amount>0)src=(sellQuote.amount-buyQuote.amount)/buyQuote.amount;
      if(src!=null&&(!Number.isFinite(src)||src<=-1)){flags.push("INVALID_ROI");src=null;trusted=false;}
      if(src!=null&&src>MAX_UNCORROBORATED_ROI){flags.push("EXTREME_ROI_REQUIRES_CORROBORATION");diagnostics.economicOutliers++;trusted=false;}
      if(lot.evidence!=="account_delta"||ex.evidence!=="account_delta")flags.push("HAS_EVENT_FALLBACK");
      const e1=econ(src,1),e5=econ(src,.5),e25=econ(src,.25);
      rts.push({mint:ex.mint,buySignature:lot.signature,sellSignature:ex.signature,buyTimestamp:lot.t,sellTimestamp:ex.timestamp,holdSeconds:Math.max(0,ex.timestamp-lot.t),qty:take,buyQuote,sellQuote,sourceRoi:src,followerNetSol:e1.net,followerRoi:e1.roi,stress50NetSol:e5.net,stress75NetSol:e25.net,evidence:`${lot.evidence}->${ex.evidence}`,trusted:trusted&&src!=null,flags});
      remaining-=take;
      if(take>=lot.qty-1e-18)a.shift();else{lot.qty-=take;if(lot.quote)lot.quote.amount*=1-buyFrac;}
    }
    if(remaining>Math.max(1e-12,totalQty*1e-8))diagnostics.unmatchedSells++;
    open.set(ex.mint,a);
  }
  return{roundTrips:rts,raw:summarize(rts,false),trusted:summarize(rts,true),diagnostics};
}
