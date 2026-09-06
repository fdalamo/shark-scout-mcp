import { promises as fs } from "node:fs";
import path from "node:path";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const VYBE_API_KEY = process.env.VYBE_API_KEY?.trim();
const STATE_PATH = process.env.SCOUT_STATE_PATH || "./data/shark-state.json";
const CHECKPOINT_PATH = process.env.SCOUT_GAUNTLET_STATE_PATH || "./data/gauntlet-state.json";
const REPORT_PATH = process.env.SCOUT_GAUNTLET_PATH || "./data/latest-gauntlet.json";
const BATCH_SIZE = clamp(Number(process.env.GAUNTLET_WALLET_LIMIT || process.env.GAUNTLET_BATCH_SIZE || 30), 5, 60);
const CONCURRENCY = clamp(Number(process.env.GAUNTLET_CONCURRENCY || 2), 1, 6);
const HELIUS_PAGES = clamp(Number(process.env.GAUNTLET_HELIUS_PAGES || 5), 1, 10);
const HELIUS_MIN_INTERVAL_MS = clamp(Number(process.env.GAUNTLET_HELIUS_MIN_INTERVAL_MS || 300), 100, 3000);
const VYBE_LOOKBACK_HOURS = clamp(Number(process.env.GAUNTLET_VYBE_LOOKBACK_HOURS || 23), 6, 47);
const UNKNOWN_RETRY_HOURS = clamp(Number(process.env.GAUNTLET_UNKNOWN_RETRY_HOURS || 6), 1, 168);
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 20000), 3000, 60000);
const FOLLOW_SIZE = 0.075;
const ODIN_RATE = 0.01;
const TIP_RATE = 0.003;
const NETWORK_PER_LEG = 0.00015;
const EVALUATOR_VERSION = "v4.1";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const QUOTES = new Set([WSOL, USDC, USDT]);

type Wallet = { address:string; status?:string; tokens?:string[]; providers?:string[]; rediscoveryCount?:number; tags?:string[]; lastSeen?:string };
type Lot = { t:number; qty:number|null; buySol:number|null };
type RoundTrip = { mint:string; holdSeconds:number; buySol:number|null; sellSol:number|null; sourceRoi:number|null; followerNetSol:number|null; followerRoi:number|null; stress50NetSol:number|null; stress75NetSol:number|null };
type Result = { address:string; fingerprint:string; evaluatedAt:string; discoveryTokens:number; rediscoveryCount:number; providers:string[]; heliusTransactions:number; heliusSwaps:number; heliusCoveragePartial:boolean; heliusError:string|null; vybeTradesWindow:number; vybeLookbackHours:number; vybeError:string|null; hold:any; robustness:any; dataQuality:any; verdict:any };
type Checkpoint = { schemaVersion:number; updatedAt:string; results:Record<string,Result>; runs:Array<any> };

function clamp(n:number,min:number,max:number){ return Math.max(min,Math.min(max,Number.isFinite(n)?Math.floor(n):min)); }
function median(v:number[]):number|null { if(!v.length)return null; const a=[...v].sort((x,y)=>x-y),m=Math.floor(a.length/2); return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2; }
function quantile(v:number[],p:number):number|null { if(!v.length)return null; const a=[...v].sort((x,y)=>x-y); return a[Math.min(a.length-1,Math.floor((a.length-1)*p))]!; }
function score(w:Wallet){ return (w.tokens?.length||0)*1000 + Math.min(w.rediscoveryCount||0,500); }
function fingerprint(w:Wallet){ return `${EVALUATOR_VERSION}|${(w.tokens||[]).slice().sort().join(",")}|${(w.tags||[]).slice().sort().join(",")}|${w.status||""}`; }
function badTag(tags:string[]=[]){ const s=tags.join(" ").toLowerCase(); for(const x of ["sniper","bundler","insider","developer","bot","mev","exchange","cex"]) if(s.includes(x))return x; return null; }
function sleep(ms:number){ return new Promise(resolve=>setTimeout(resolve,ms)); }
function retryableStatus(status:number){ return status===408||status===425||status===429||status>=500; }
async function fetchJson(url:string,init:RequestInit={},attempts=3){
  let last:Error|undefined;
  for(let attempt=0;attempt<attempts;attempt++){
    const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT_MS);
    try{
      const r=await fetch(url,{...init,signal:c.signal});
      const text=await r.text();
      if(r.ok)return text?JSON.parse(text):null;
      const err=new Error(`${r.status}:${text.slice(0,220)}`); last=err;
      if(!retryableStatus(r.status)||attempt===attempts-1)throw err;
      const retryAfter=Number(r.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:650*(2**attempt)+Math.floor(Math.random()*300));
    }catch(e){
      last=e instanceof Error?e:new Error(String(e));
      if(attempt===attempts-1)throw last;
      await sleep(650*(2**attempt)+Math.floor(Math.random()*300));
    }finally{ clearTimeout(t); }
  }
  throw last||new Error("fetch failed");
}
async function atomicSave(file:string,data:any){ await fs.mkdir(path.dirname(file),{recursive:true}); const tmp=`${file}.tmp`; await fs.writeFile(tmp,JSON.stringify(data,null,2)); await fs.rename(tmp,file); }
async function loadCheckpoint():Promise<Checkpoint>{ try{ const x=JSON.parse(await fs.readFile(CHECKPOINT_PATH,"utf8")); return {schemaVersion:5,updatedAt:x.updatedAt||new Date().toISOString(),results:x.results||{},runs:Array.isArray(x.runs)?x.runs:[]}; }catch{ return {schemaVersion:5,updatedAt:new Date().toISOString(),results:{},runs:[]}; } }

let heliusNextAt=0;
async function heliusThrottle(){ const wait=Math.max(0,heliusNextAt-Date.now()); if(wait)await sleep(wait); heliusNextAt=Math.max(Date.now(),heliusNextAt)+HELIUS_MIN_INTERVAL_MS; }
async function heliusPage(address:string,before:string|undefined,swapOnly:boolean){
  await heliusThrottle();
  const u=new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
  u.searchParams.set("api-key",HELIUS_API_KEY!); u.searchParams.set("limit","100");
  if(before)u.searchParams.set("before",before); if(swapOnly)u.searchParams.set("type","SWAP");
  return fetchJson(u.toString(),{},4);
}
async function heliusHistory(address:string){
  if(!HELIUS_API_KEY)return{rows:[] as any[],error:"HELIUS_API_KEY missing",partial:true,swapFiltered:false};
  const all:any[]=[]; let before:string|undefined; let partial=false,swapFiltered=true;
  try{
    for(let page=0;page<HELIUS_PAGES;page++){
      let x:any;
      try{x=await heliusPage(address,before,true);}catch(e){
        if(page===0&&String(e).startsWith("Error: 400")){ swapFiltered=false; x=await heliusPage(address,before,false); }
        else throw e;
      }
      if(!Array.isArray(x)||!x.length)break;
      all.push(...x); before=x[x.length-1]?.signature;
      if(x.length<100)break;
      if(page===HELIUS_PAGES-1&&x.length===100)partial=true;
    }
    return{rows:all,error:null,partial,swapFiltered};
  }catch(e){ return{rows:all,error:String(e),partial:true,swapFiltered}; }
}
async function vybeTrades(address:string){
  if(!VYBE_API_KEY)return{rows:[] as any[],error:"VYBE_API_KEY missing"};
  try{
    const end=Math.floor(Date.now()/1000)-300,start=end-VYBE_LOOKBACK_HOURS*3600;
    const q=new URLSearchParams({authorityAddress:address,timeStart:String(start),timeEnd:String(end),limit:"500",page:"0",sortByAsc:"blockTime"});
    const x=await fetchJson(`https://api.vybenetwork.xyz/v4/trades?${q}`,{headers:{"X-API-Key":VYBE_API_KEY}},3);
    return{rows:Array.isArray(x?.data)?x.data:[],error:null};
  }catch(e){ return{rows:[],error:String(e)}; }
}
function num(v:any):number|null { const n=Number(v); return Number.isFinite(n)?n:null; }
function nativeSol(x:any){ const n=num(x?.amount); return n==null?null:n/1e9; }
function followerEconomics(sourceRoi:number|null,retention=1){ if(sourceRoi==null)return{net:null,roi:null}; const buyFee=Math.max(FOLLOW_SIZE*ODIN_RATE,0.001),buyTip=FOLLOW_SIZE*TIP_RATE,buyTotal=FOLLOW_SIZE+buyFee+buyTip+NETWORK_PER_LEG; const grossExit=Math.max(0,FOLLOW_SIZE*(1+sourceRoi*retention)); const sellFee=Math.max(grossExit*ODIN_RATE,0.001),sellTip=grossExit*TIP_RATE,netExit=grossExit-sellFee-sellTip-NETWORK_PER_LEG,net=netExit-buyTotal; return{net,roi:net/buyTotal}; }
function quoteSolFromTransfers(tx:any,wallet:string,direction:"out"|"in"){ let total=0,seen=false; for(const x of tx?.nativeTransfers||[]){ const hit=direction==="out"?x?.fromUserAccount===wallet:x?.toUserAccount===wallet; if(hit){const v=nativeSol(x);if(v!=null){total+=v;seen=true;}} } for(const x of tx?.tokenTransfers||[]){ if(x?.mint!==WSOL)continue; const hit=direction==="out"?x?.fromUserAccount===wallet:x?.toUserAccount===wallet; if(hit){const v=num(x?.tokenAmount);if(v!=null){total+=v;seen=true;}} } return seen?total:null; }
function extractTrade(tx:any,wallet:string){
  const buys:Array<{mint:string;qty:number|null}> = [], sells:Array<{mint:string;qty:number|null}> = [];
  const ev=tx?.events?.swap;
  if(ev){
    for(const x of ev.tokenOutputs||[])if(x?.userAccount===wallet&&!QUOTES.has(x?.mint))buys.push({mint:x.mint,qty:num(x?.rawTokenAmount?.tokenAmount??x?.tokenAmount)});
    for(const x of ev.tokenInputs||[])if(x?.userAccount===wallet&&!QUOTES.has(x?.mint))sells.push({mint:x.mint,qty:num(x?.rawTokenAmount?.tokenAmount??x?.tokenAmount)});
  }
  if(!buys.length&&!sells.length){
    for(const x of tx?.tokenTransfers||[]){
      if(!x?.mint||QUOTES.has(x.mint))continue;
      const q=num(x?.tokenAmount);
      if(x?.toUserAccount===wallet&&x?.fromUserAccount!==wallet)buys.push({mint:x.mint,qty:q});
      if(x?.fromUserAccount===wallet&&x?.toUserAccount!==wallet)sells.push({mint:x.mint,qty:q});
    }
  }
  const nativeInput=nativeSol(ev?.nativeInput),nativeOutput=nativeSol(ev?.nativeOutput);
  const buyQuoteSol=nativeInput??quoteSolFromTransfers(tx,wallet,"out");
  const sellQuoteSol=nativeOutput??quoteSolFromTransfers(tx,wallet,"in");
  return{buys,sells,buyQuoteSol,sellQuoteSol};
}
function holds(rows:any[],wallet:string){
  const ordered=[...rows].filter(x=>Number.isFinite(Number(x?.timestamp))).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp));
  const open=new Map<string,Lot[]>(),rts:RoundTrip[]=[]; let buys=0,sells=0,parsedSwaps=0;
  for(const tx of ordered){
    const t=Number(tx.timestamp),ex=extractTrade(tx,wallet); if(!ex.buys.length&&!ex.sells.length)continue; parsedSwaps++;
    for(const b of ex.buys){ buys++; const a=open.get(b.mint)||[]; a.push({t,qty:b.qty,buySol:ex.buys.length===1?ex.buyQuoteSol:null}); open.set(b.mint,a); }
    for(const s of ex.sells){
      sells++; const a=open.get(s.mint)||[]; if(!a.length)continue; let remaining=s.qty;
      while(a.length&&(remaining==null||remaining>0)){
        const lot=a[0]!, lotQty=lot.qty, closeQty=remaining==null||lotQty==null?lotQty:Math.min(remaining,lotQty);
        const fraction=lotQty&&closeQty!=null?Math.min(1,closeQty/lotQty):1;
        const buySol=lot.buySol==null?null:lot.buySol*fraction;
        const sellSol=ex.sells.length===1&&ex.sellQuoteSol!=null?ex.sellQuoteSol*fraction:null;
        const src=buySol&&sellSol!=null?(sellSol-buySol)/buySol:null,full=followerEconomics(src,1),stress50=followerEconomics(src,.5),stress75=followerEconomics(src,.25);
        rts.push({mint:s.mint,holdSeconds:Math.max(0,t-lot.t),buySol,sellSol,sourceRoi:src,followerNetSol:full.net,followerRoi:full.roi,stress50NetSol:stress50.net,stress75NetSol:stress75.net});
        if(remaining==null||lotQty==null||closeQty==null||closeQty>=lotQty){a.shift();remaining=null;} else {lot.qty=lotQty-closeQty; if(lot.buySol!=null)lot.buySol*=1-fraction; remaining-=closeQty;}
      }
      open.set(s.mint,a);
    }
  }
  const hs=rts.map(x=>x.holdSeconds),fr=rts.map(x=>x.followerRoi).filter((x):x is number=>x!=null),nets=rts.map(x=>x.followerNetSol).filter((x):x is number=>x!=null),n50=rts.map(x=>x.stress50NetSol).filter((x):x is number=>x!=null),n75=rts.map(x=>x.stress75NetSol).filter((x):x is number=>x!=null);
  return{closedHolds:hs.length,medianHoldSeconds:median(hs),p25HoldSeconds:quantile(hs,.25),p75HoldSeconds:quantile(hs,.75),fastUnder10m:hs.filter(x=>x<600).length,slowOver6h:hs.filter(x=>x>=21600).length,idealOver12h:hs.filter(x=>x>=43200).length,buyEvents:buys,sellEvents:sells,parsedSwaps,estimatedFollowerTrades:fr.length,estimatedFollowerWinRate:fr.length?fr.filter(x=>x>0).length/fr.length:null,estimatedFollowerMedianRoi:median(fr),estimatedFollowerNetSol:nets.length?nets.reduce((a,b)=>a+b,0):null,stress50NetSol:n50.length?n50.reduce((a,b)=>a+b,0):null,stress75NetSol:n75.length?n75.reduce((a,b)=>a+b,0):null,roundTrips:rts.slice(-60)};
}
function robustness(h:any){ const nets=(h.roundTrips||[]).map((x:any)=>x.followerNetSol).filter((x:any)=>typeof x==="number") as number[]; const positive=nets.filter(x=>x>0),totalPositive=positive.reduce((a,b)=>a+b,0),largest=positive.length?Math.max(...positive):0; return{positiveTrades:positive.length,largestWinnerShare:totalPositive>0?largest/totalPositive:null,antiJackpotPass:totalPositive>0?largest/totalPositive<=0.6:null,stress50Positive:typeof h.stress50NetSol==="number"?h.stress50NetSol>0:null,stress75Positive:typeof h.stress75NetSol==="number"?h.stress75NetSol>0:null}; }
function dataQuality(h:any,hx:any,vt:any){ const holdScore=Math.min(1,h.closedHolds/8),tradeScore=Math.min(1,h.estimatedFollowerTrades/5),coveragePenalty=hx.partial?.15:0,errorPenalty=hx.error?.25:0; return{score:Math.max(0,Math.min(1,.55*holdScore+.35*tradeScore+.10*(vt.rows.length>0?1:0)-coveragePenalty-errorPenalty)),closedHoldAdequate:h.closedHolds>=5,economicSampleAdequate:h.estimatedFollowerTrades>=5,vybeAvailable:vt.rows.length>0,heliusPartial:hx.partial}; }
function verdict(w:Wallet,h:any,r:any,q:any,errors:string[],partial:boolean){
  const tag=badTag(w.tags); if(tag)return{status:"REJECT",stage:"hard_gate",reasons:[`bad_tag:${tag}`]};
  const medh=h.medianHoldSeconds,reasons:string[]=[];
  if(partial)reasons.push("helius_history_window_partial"); if(h.closedHolds<5)reasons.push("closed_hold_sample_under_5");
  if(medh==null)reasons.push("hold_time_unknown"); else if(medh<600)reasons.push("median_hold_under_10m"); else if(medh<3600)reasons.push("median_hold_10m_to_1h"); else if(medh<21600)reasons.push("median_hold_1h_to_6h"); else if(medh<43200)reasons.push("median_hold_6h_plus"); else reasons.push("median_hold_12h_plus");
  if((w.tokens?.length||0)<2)reasons.push("single_discovery_token"); else reasons.push(`cross_token_${w.tokens!.length}`); if(errors.length)reasons.push(...errors);
  if(h.closedHolds>=3&&medh!=null&&medh<600)return{status:"REJECT",stage:"hold_time",reasons};
  if(h.closedHolds>=3&&medh!=null&&medh<3600)return{status:"SIGNAL_ONLY",stage:"hold_time",reasons};
  if(h.estimatedFollowerTrades>=5&&h.estimatedFollowerNetSol!=null&&h.estimatedFollowerNetSol<=0)return{status:"REJECT",stage:"fixed_size_economics",reasons:[...reasons,"0.075_estimated_net_nonpositive"]};
  if(r.antiJackpotPass===false&&h.estimatedFollowerTrades>=5)return{status:"REJECT",stage:"robustness",reasons:[...reasons,"largest_winner_over_60pct_positive_pnl"]};
  if(medh!=null&&medh>=21600&&h.closedHolds>=8&&(w.tokens?.length||0)>=2&&h.estimatedFollowerTrades>=5&&h.estimatedFollowerNetSol>0&&r.antiJackpotPass===true&&r.stress50Positive===true&&q.score>=.55)return{status:"DEEP_DIVE",stage:"pre_replay",reasons:[...reasons,"0.075_fee_model_positive","anti_jackpot_pass","50pct_alpha_retention_positive","needs_exact_price_lag_liquidity_replay"]};
  if(medh!=null&&medh>=3600&&h.closedHolds>=5)return{status:"SIGNAL_ONLY",stage:"needs_more_economic_evidence",reasons};
  return{status:"UNKNOWN",stage:"insufficient_evidence",reasons};
}
async function evaluate(w:Wallet):Promise<Result>{
  const [hx,vt]=await Promise.all([heliusHistory(w.address),vybeTrades(w.address)]); const h=holds(hx.rows,w.address),r=robustness(h),q=dataQuality(h,hx,vt),errors:string[]=[];
  if(hx.error)errors.push("helius_history_error"); if(vt.error)errors.push("vybe_history_unavailable"); const v=verdict(w,h,r,q,errors,hx.partial);
  return{address:w.address,fingerprint:fingerprint(w),evaluatedAt:new Date().toISOString(),discoveryTokens:w.tokens?.length||0,rediscoveryCount:w.rediscoveryCount||0,providers:w.providers||[],heliusTransactions:hx.rows.length,heliusSwaps:hx.rows.filter(x=>x?.type==="SWAP").length,heliusCoveragePartial:hx.partial,heliusError:hx.error,vybeTradesWindow:vt.rows.length,vybeLookbackHours:VYBE_LOOKBACK_HOURS,vybeError:vt.error,hold:h,robustness:r,dataQuality:q,verdict:v};
}
function failedResult(w:Wallet,e:unknown):Result{ const msg=e instanceof Error?e.message:String(e),h={closedHolds:0,medianHoldSeconds:null,p25HoldSeconds:null,p75HoldSeconds:null,fastUnder10m:0,slowOver6h:0,idealOver12h:0,buyEvents:0,sellEvents:0,parsedSwaps:0,estimatedFollowerTrades:0,estimatedFollowerWinRate:null,estimatedFollowerMedianRoi:null,estimatedFollowerNetSol:null,stress50NetSol:null,stress75NetSol:null,roundTrips:[]},q={score:0,closedHoldAdequate:false,economicSampleAdequate:false,vybeAvailable:false,heliusPartial:true}; return{address:w.address,fingerprint:fingerprint(w),evaluatedAt:new Date().toISOString(),discoveryTokens:w.tokens?.length||0,rediscoveryCount:w.rediscoveryCount||0,providers:w.providers||[],heliusTransactions:0,heliusSwaps:0,heliusCoveragePartial:true,heliusError:msg,vybeTradesWindow:0,vybeLookbackHours:VYBE_LOOKBACK_HOURS,vybeError:null,hold:h,robustness:robustness(h),dataQuality:q,verdict:{status:"UNKNOWN",stage:"evaluation_error",reasons:["wallet_evaluation_exception"]}}; }
function shouldEvaluate(w:Wallet,prev:Result|undefined){ if(!prev)return true; if(prev.fingerprint!==fingerprint(w))return true; if(prev.verdict?.status!=="UNKNOWN")return false; const transient=prev.verdict?.stage==="evaluation_error"||Boolean(prev.heliusError)||Boolean(prev.vybeError); if(!transient)return false; const age=Date.now()-Date.parse(prev.evaluatedAt||""); return !Number.isFinite(age)||age>=UNKNOWN_RETRY_HOURS*3600_000; }

export async function runGauntlet(){
  const startedAt=new Date().toISOString(),state=JSON.parse(await fs.readFile(STATE_PATH,"utf8")),cp=await loadCheckpoint();
  const eligible=(Object.values(state.wallets||{}) as Wallet[]).filter(w=>w.status!=="REJECTED").sort((a,b)=>score(b)-score(a)); const pending=eligible.filter(w=>shouldEvaluate(w,cp.results[w.address])),batch=pending.slice(0,BATCH_SIZE); let completedThisRun=0;
  for(let i=0;i<batch.length;i+=CONCURRENCY){ const wave=batch.slice(i,i+CONCURRENCY),results=await Promise.all(wave.map(async w=>{try{return await evaluate(w);}catch(e){return failedResult(w,e);}})); for(const r of results)cp.results[r.address]=r; completedThisRun+=results.length; cp.updatedAt=new Date().toISOString(); await atomicSave(CHECKPOINT_PATH,cp); }
  const current=eligible.map(w=>cp.results[w.address]).filter((x):x is Result=>Boolean(x)&&x.fingerprint.startsWith(`${EVALUATOR_VERSION}|`)); const counts=current.reduce((a:any,x:any)=>(a[x.verdict.status]=(a[x.verdict.status]||0)+1,a),{}),deep=current.filter(x=>x.verdict.status==="DEEP_DIVE").sort((a,b)=>(b.hold.estimatedFollowerNetSol||-999)-(a.hold.estimatedFollowerNetSol||-999)); const remaining=eligible.filter(w=>shouldEvaluate(w,cp.results[w.address])).length;
  const runSummary={startedAt,finishedAt:new Date().toISOString(),evaluatorVersion:EVALUATOR_VERSION,eligible:eligible.length,processedThisRun:completedThisRun,processedCumulative:current.length,remaining,counts}; cp.runs=[...cp.runs.slice(-99),runSummary]; cp.updatedAt=new Date().toISOString(); await atomicSave(CHECKPOINT_PATH,cp);
  const report={schemaVersion:5,generatedAt:new Date().toISOString(),...runSummary,note:"Resumable preliminary copyability gauntlet. Helius requests are swap-filtered when supported and rate-limited; Vybe free-tier evidence is limited to a safe sub-2-day window. DEEP_DIVE is not LIVE-TEST WORTHY until exact raw economic and source-to-copy lag/liquidity/slippage replay passes.",deepDive:deep.slice(0,25),results:current}; await atomicSave(REPORT_PATH,report);
  console.log(JSON.stringify({event:"shark_scout_gauntlet_complete",generatedAt:report.generatedAt,evaluatorVersion:EVALUATOR_VERSION,processedThisRun:completedThisRun,processedCumulative:current.length,remaining,counts,deepDive:deep.slice(0,10).map(x=>({address:x.address,medianHoldSeconds:x.hold.medianHoldSeconds,closedHolds:x.hold.closedHolds,discoveryTokens:x.discoveryTokens,estimatedFollowerNetSol:x.hold.estimatedFollowerNetSol,stress50NetSol:x.hold.stress50NetSol,largestWinnerShare:x.robustness.largestWinnerShare,dataQuality:x.dataQuality.score,reasons:x.verdict.reasons}))})); return report;
}
if(import.meta.url===`file://${process.argv[1]}`)runGauntlet().catch(e=>{console.error(JSON.stringify({event:"shark_scout_gauntlet_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});