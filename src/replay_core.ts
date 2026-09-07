export const WSOL="So11111111111111111111111111111111111111112";
export const USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const NATIVE_SOL="SOL";
export const QUOTE_MINTS=new Set([WSOL,USDC,USDT]);

export type Quote={mint:string;amount:number};
export type Evidence="account_delta"|"event_fallback";
export type ClassifiedTrade={side:"BUY"|"SELL";mint:string;qty:number;quote:Quote|null;evidence:Evidence;confidence:"HIGH"|"MEDIUM";signature:string;timestamp:number;flags:string[]};
export type ReplayTrade={mint:string;buySignature:string;sellSignature:string;buyTimestamp:number;sellTimestamp:number;holdSeconds:number;qty:number;buyQuote:Quote|null;sellQuote:Quote|null;sourceRoi:number|null;followerNetSol:number|null;followerRoi:number|null;stress50NetSol:number|null;stress75NetSol:number|null;evidence:string;trusted:boolean;flags:string[]};
export type ReplayDiagnostics={swapLike:number;classified:number;accountDelta:number;eventFallbacks:number;ambiguous:number;ambiguousReasons:Record<string,number>;tokenToToken:number;unmatchedSells:number;quoteMismatch:number;economicOutliers:number};
export type ReplaySummary={trades:number;netSol:number|null;stress50NetSol:number|null;winRate:number|null;medianRoi:number|null;largestWinnerShare:number|null};
export type ReplayResult={roundTrips:ReplayTrade[];raw:ReplaySummary;trusted:ReplaySummary;diagnostics:ReplayDiagnostics};

type Lot={t:number;qty:number;quote:Quote|null;signature:string;evidence:Evidence;flags:string[]};
const FOLLOW_SIZE=.075,ODIN_RATE=.01,TIP_RATE=.003,NETWORK_PER_LEG=.00015;
const MIN_SOL_QUOTE=.0003,MIN_STABLE_QUOTE=.03,MAX_UNCORROBORATED_ROI=250;

function n(v:any):number|null{const x=Number(v);return Number.isFinite(x)?x:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
function median(xs:number[]){if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;}
function canonicalQuote(m:string){return m===WSOL||m===NATIVE_SOL?NATIVE_SOL:m;}
function sameQuote(a:Quote|null,b:Quote|null){return Boolean(a&&b&&canonicalQuote(a.mint)===canonicalQuote(b.mint));}
function inc(o:Record<string,number>,k:string){o[k]=(o[k]||0)+1;}
function minQuote(m:string){return m===NATIVE_SOL?MIN_SOL_QUOTE:MIN_STABLE_QUOTE;}

function rawUi(raw:any,dec:any):number|null{
  if(raw==null)return null;const d=n(dec);if(d==null||d<0||d>30)return n(raw);
  const s=String(raw);if(!/^-?\d+$/.test(s)){const x=n(raw);return x==null?null:x/10**d;}
  const neg=s[0]==="-",digits=neg?s.slice(1):s,p=digits.padStart(d+1,"0"),i=p.length-d;
  const x=Number(`${neg?"-":""}${p.slice(0,i)}${d?"."+p.slice(i):""}`);return Number.isFinite(x)?x:null;
}
function amountChange(x:any){const r=x?.rawTokenAmount;if(r?.tokenAmount!=null){const z=rawUi(r.tokenAmount,r.decimals);if(z!=null)return z;}return n(x?.tokenAmount);}
function amountEvent(x:any){const r=x?.rawTokenAmount;if(r?.tokenAmount!=null){const z=rawUi(r.tokenAmount,r.decimals);if(z!=null)return z;}return n(x?.tokenAmount);}

function accountDeltas(tx:any,wallet:string){
  const token=new Map<string,number>();let native=0,nativeSeen=false;
  for(const ad of tx?.accountData||[]){
    if(ad?.account===wallet){const d=n(ad?.nativeBalanceChange);if(d!=null){native+=d/1e9;nativeSeen=true;}}
    for(const tb of ad?.tokenBalanceChanges||[]){if(tb?.userAccount!==wallet||!tb?.mint)continue;const q=amountChange(tb);if(q==null||Math.abs(q)<1e-18)continue;const m=String(tb.mint);token.set(m,(token.get(m)||0)+q);}
  }
  const payer=String(tx?.feePayer||tx?.fee_payer||""),fee=n(tx?.fee);if(nativeSeen&&payer===wallet&&fee!=null&&fee>0)native+=fee/1e9;
  return{token,native:nativeSeen?native:null};
}
function quoteDeltas(d:{token:Map<string,number>;native:number|null}){const q=new Map<string,number>(),sol=(d.native||0)+(d.token.get(WSOL)||0);if(Math.abs(sol)>1e-12)q.set(NATIVE_SOL,sol);for(const m of[USDC,USDT]){const x=d.token.get(m)||0;if(Math.abs(x)>1e-12)q.set(m,x);}return q;}
function material(q:Map<string,number>,sign:1|-1){return[...q].filter(([m,v])=>sign*v>minQuote(m));}
function isQuote(m:string){return m===NATIVE_SOL||QUOTE_MINTS.has(m);}

function eventFallback(tx:any,wallet:string):ClassifiedTrade|null{
  const ev=tx?.events?.swap;if(!ev)return null;const pos=new Map<string,number>(),neg=new Map<string,number>();
  for(const x of ev?.tokenOutputs||[]){if(x?.userAccount!==wallet||!x?.mint)continue;const q=amountEvent(x);if(q!=null&&q>0){const m=String(x.mint);pos.set(m,(pos.get(m)||0)+q);}}
  for(const x of ev?.tokenInputs||[]){if(x?.userAccount!==wallet||!x?.mint)continue;const q=amountEvent(x);if(q!=null&&q>0){const m=String(x.mint);neg.set(m,(neg.get(m)||0)+q);}}
  const ni=n(ev?.nativeInput?.amount),no=n(ev?.nativeOutput?.amount);if(ni!=null&&ni>0)neg.set(NATIVE_SOL,(neg.get(NATIVE_SOL)||0)+ni/1e9);if(no!=null&&no>0)pos.set(NATIVE_SOL,(pos.get(NATIVE_SOL)||0)+no/1e9);
  const pin=[...pos].filter(([m])=>!isQuote(m)),nout=[...neg].filter(([m])=>!isQuote(m)),qs=[...neg].filter(([m,v])=>isQuote(m)&&v>minQuote(canonicalQuote(m))),qr=[...pos].filter(([m,v])=>isQuote(m)&&v>minQuote(canonicalQuote(m)));
  const signature=String(tx?.signature||""),timestamp=Number(tx?.timestamp||0),flags=["EVENT_FALLBACK"];
  if(pin.length===1&&nout.length===0&&qs.length===1){const[mint,qty]=pin[0]!,[qm,qa]=qs[0]!;return{side:"BUY",mint,qty,quote:{mint:canonicalQuote(qm),amount:qa},evidence:"event_fallback",confidence:"MEDIUM",signature,timestamp,flags};}
  if(nout.length===1&&pin.length===0&&qr.length===1){const[mint,qty]=nout[0]!,[qm,qa]=qr[0]!;return{side:"SELL",mint,qty,quote:{mint:canonicalQuote(qm),amount:qa},evidence:"event_fallback",confidence:"MEDIUM",signature,timestamp,flags};}
  return null;
}

export function classifyEnhancedTransaction(tx:any,wallet:string):{trade:ClassifiedTrade|null;reason:string|null;tokenToToken:boolean}{
  if(!(String(tx?.type||"").toUpperCase()==="SWAP"||tx?.events?.swap))return{trade:null,reason:"NOT_SWAP",tokenToToken:false};
  if(tx?.transactionError||tx?.error)return{trade:null,reason:"FAILED_TX",tokenToToken:false};
  const d=accountDeltas(tx,wallet),pos:[string,number][]=[],neg:[string,number][]=[];for(const[m,q]of d.token){if(QUOTE_MINTS.has(m)||Math.abs(q)<1e-18)continue;(q>0?pos:neg).push([m,Math.abs(q)]);}const q=quoteDeltas(d),spent=material(q,-1),recv=material(q,1),signature=String(tx?.signature||""),timestamp=Number(tx?.timestamp||0);
  if(pos.length===1&&neg.length===0&&spent.length===1&&recv.length===0){const[mint,qty]=pos[0]!,[qm,v]=spent[0]!;return{trade:{side:"BUY",mint,qty,quote:{mint:canonicalQuote(qm),amount:Math.abs(v)},evidence:"account_delta",confidence:"HIGH",signature,timestamp,flags:[]},reason:null,tokenToToken:false};}
  if(neg.length===1&&pos.length===0&&recv.length===1&&spent.length===0){const[mint,qty]=neg[0]!,[qm,v]=recv[0]!;return{trade:{side:"SELL",mint,qty,quote:{mint:canonicalQuote(qm),amount:Math.abs(v)},evidence:"account_delta",confidence:"HIGH",signature,timestamp,flags:[]},reason:null,tokenToToken:false};}
  const tokenToToken=pos.length>0&&neg.length>0&&spent.length===0&&recv.length===0;if(tokenToToken)return{trade:null,reason:"TOKEN_TO_TOKEN_NO_EXACT_QUOTE",tokenToToken:true};
  const fb=eventFallback(tx,wallet);if(fb)return{trade:fb,reason:null,tokenToToken:false};
  let reason="AMBIGUOUS";if(pos.length+neg.length===0)reason="NO_NONQUOTE_DELTA";else if(spent.length+recv.length===0)reason="NO_QUOTE_DELTA";else if(spent.length+recv.length>1)reason="MULTIPLE_QUOTE_DELTAS";else if(pos.length+neg.length>1)reason="MULTIPLE_NONQUOTE_DELTAS";return{trade:null,reason,tokenToToken:false};
}

function econ(r:number|null,retain=1){if(r==null||!Number.isFinite(r)||r<=-1)return{net:null,roi:null};const bf=Math.max(FOLLOW_SIZE*ODIN_RATE,.001),bt=FOLLOW_SIZE*TIP_RATE,cost=FOLLOW_SIZE+bf+bt+NETWORK_PER_LEG,gross=Math.max(0,FOLLOW_SIZE*(1+r*retain)),sf=Math.max(gross*ODIN_RATE,.001),st=gross*TIP_RATE,net=gross-sf-st-NETWORK_PER_LEG-cost;return{net,roi:net/cost};}
function summary(ts:ReplayTrade[],trusted:boolean):ReplaySummary{const xs=trusted?ts.filter(x=>x.trusted):ts.filter(x=>x.followerNetSol!=null),nets=xs.map(x=>x.followerNetSol).filter((x):x is number=>x!=null),s=xs.map(x=>x.stress50NetSol).filter((x):x is number=>x!=null),rois=xs.map(x=>x.followerRoi).filter((x):x is number=>x!=null),wins=nets.filter(x=>x>0),gw=sum(wins),lw=wins.length?Math.max(...wins):0;return{trades:nets.length,netSol:nets.length?sum(nets):null,stress50NetSol:s.length?sum(s):null,winRate:nets.length?wins.length/nets.length:null,medianRoi:median(rois),largestWinnerShare:gw>0?lw/gw:null};}

export function replayEnhancedRows(rows:any[],wallet:string):ReplayResult{
  const ordered=[...rows].filter(x=>Number.isFinite(Number(x?.timestamp))).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)),open=new Map<string,Lot[]>(),rts:ReplayTrade[]=[];
  const diagnostics:ReplayDiagnostics={swapLike:0,classified:0,accountDelta:0,eventFallbacks:0,ambiguous:0,ambiguousReasons:{},tokenToToken:0,unmatchedSells:0,quoteMismatch:0,economicOutliers:0};
  for(const tx of ordered){if(!(String(tx?.type||"").toUpperCase()==="SWAP"||tx?.events?.swap))continue;diagnostics.swapLike++;const c=classifyEnhancedTransaction(tx,wallet);if(!c.trade){if(c.tokenToToken)diagnostics.tokenToToken++;else{diagnostics.ambiguous++;inc(diagnostics.ambiguousReasons,c.reason||"UNKNOWN");}continue;}const ex=c.trade;diagnostics.classified++;ex.evidence==="account_delta"?diagnostics.accountDelta++:diagnostics.eventFallbacks++;
    if(ex.side==="BUY"){const a=open.get(ex.mint)||[];a.push({t:ex.timestamp,qty:ex.qty,quote:ex.quote,signature:ex.signature,evidence:ex.evidence,flags:[...ex.flags]});open.set(ex.mint,a);continue;}
    const a=open.get(ex.mint)||[];let rem=ex.qty,total=ex.qty;if(!a.length){diagnostics.unmatchedSells++;continue;}while(a.length&&rem>1e-18){const lot=a[0]!,take=Math.min(rem,lot.qty),bf=take/lot.qty,sf=total>0?take/total:0,bq=lot.quote?{...lot.quote,amount:lot.quote.amount*bf}:null,sq=ex.quote?{...ex.quote,amount:ex.quote.amount*sf}:null,flags=[...lot.flags,...ex.flags];let roi:number|null=null,trusted=true;if(!sameQuote(bq,sq)){flags.push("QUOTE_MISMATCH_OR_UNKNOWN");diagnostics.quoteMismatch++;trusted=false;}else if(bq&&sq&&bq.amount>0)roi=(sq.amount-bq.amount)/bq.amount;if(roi!=null&&(!Number.isFinite(roi)||roi<=-1)){flags.push("INVALID_ROI");roi=null;trusted=false;}if(roi!=null&&roi>MAX_UNCORROBORATED_ROI){flags.push("EXTREME_ROI_REQUIRES_CORROBORATION");diagnostics.economicOutliers++;trusted=false;}if(lot.evidence!=="account_delta"||ex.evidence!=="account_delta")flags.push("HAS_EVENT_FALLBACK");const e=econ(roi),e5=econ(roi,.5),e25=econ(roi,.25);rts.push({mint:ex.mint,buySignature:lot.signature,sellSignature:ex.signature,buyTimestamp:lot.t,sellTimestamp:ex.timestamp,holdSeconds:Math.max(0,ex.timestamp-lot.t),qty:take,buyQuote:bq,sellQuote:sq,sourceRoi:roi,followerNetSol:e.net,followerRoi:e.roi,stress50NetSol:e5.net,stress75NetSol:e25.net,evidence:`${lot.evidence}->${ex.evidence}`,trusted:trusted&&roi!=null,flags});rem-=take;if(take>=lot.qty-1e-18)a.shift();else{lot.qty-=take;if(lot.quote)lot.quote.amount*=1-bf;}}
    if(rem>Math.max(1e-12,total*1e-8))diagnostics.unmatchedSells++;open.set(ex.mint,a);
  }
  return{roundTrips:rts,raw:summary(rts,false),trusted:summary(rts,true),diagnostics};
}
