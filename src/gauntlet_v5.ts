import { promises as fs } from "node:fs";
import path from "node:path";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const VYBE_API_KEY = process.env.VYBE_API_KEY?.trim();
const STATE_PATH = process.env.SCOUT_STATE_PATH || "./data/shark-state.json";
const CHECKPOINT_PATH = process.env.SCOUT_GAUNTLET_STATE_PATH || "./data/gauntlet-state.json";
const REPORT_PATH = process.env.SCOUT_GAUNTLET_PATH || "./data/latest-gauntlet.json";
const HELIUS_CACHE_PATH = process.env.SCOUT_HELIUS_CACHE_PATH || "./data/helius-cache.json";

const PREFILTER_LIMIT = clamp(Number(process.env.GAUNTLET_PREFILTER_LIMIT || 220), 20, 500);
const FULL_LIMIT = clamp(Number(process.env.GAUNTLET_FULL_LIMIT || 140), 10, 300);
const TIME_BUDGET_MS = clamp(Number(process.env.GAUNTLET_TIME_BUDGET_SECONDS || 840), 120, 3000) * 1000;
const CONCURRENCY = clamp(Number(process.env.GAUNTLET_CONCURRENCY || 2), 1, 6);
const HELIUS_PAGES = clamp(Number(process.env.GAUNTLET_HELIUS_PAGES || 5), 1, 12);
const HELIUS_MIN_INTERVAL_MS = clamp(Number(process.env.GAUNTLET_HELIUS_MIN_INTERVAL_MS || 300), 100, 3000);
const CACHE_MAX_AGE_MIN = clamp(Number(process.env.GAUNTLET_CACHE_MAX_AGE_MINUTES || 180), 10, 1440);
const VYBE_LOOKBACK_HOURS = clamp(Number(process.env.GAUNTLET_VYBE_LOOKBACK_HOURS || 23), 6, 47);
const UNKNOWN_RETRY_HOURS = clamp(Number(process.env.GAUNTLET_UNKNOWN_RETRY_HOURS || 6), 1, 168);
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 25000), 3000, 60000);
const FOLLOW_SIZE = 0.075;
const ODIN_RATE = 0.01;
const TIP_RATE = 0.003;
const NETWORK_PER_LEG = 0.00015;
const EVALUATOR_VERSION = "v5.0";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const QUOTES = new Set([WSOL, USDC, USDT]);

type Wallet = { address:string; status?:string; tokens?:string[]; providers?:string[]; rediscoveryCount?:number; tags?:string[]; lastSeen?:string; profile?:any };
type Lot = { t:number; qty:number|null; buySol:number|null };
type RoundTrip = { mint:string; buyTimestamp:number; sellTimestamp:number; holdSeconds:number; buySol:number|null; sellSol:number|null; sourceRoi:number|null; followerNetSol:number|null; followerRoi:number|null; stress50NetSol:number|null; stress75NetSol:number|null };
type Result = { address:string; fingerprint:string; evaluatedAt:string; discoveryTokens:number; rediscoveryCount:number; providers:string[]; prefilter:any; heliusTransactions:number; heliusSwaps:number; heliusCoveragePartial:boolean; heliusError:string|null; vybeTradesWindow:number; vybeLookbackHours:number; vybeError:string|null; hold:any; replay:any; robustness:any; dataQuality:any; verdict:any };
type Checkpoint = { schemaVersion:number; updatedAt:string; results:Record<string,Result>; prefilter:Record<string,any>; runs:Array<any> };
type Cache = { schemaVersion?:number; updatedAt?:string; wallets?:Record<string,{fetchedAt:string;rows:any[]}> };

function clamp(n:number,min:number,max:number){ return Math.max(min,Math.min(max,Number.isFinite(n)?Math.floor(n):min)); }
function median(v:number[]):number|null { if(!v.length)return null; const a=[...v].sort((x,y)=>x-y),m=Math.floor(a.length/2); return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2; }
function quantile(v:number[],p:number):number|null { if(!v.length)return null; const a=[...v].sort((x,y)=>x-y); return a[Math.min(a.length-1,Math.floor((a.length-1)*p))]!; }
function score(w:Wallet){ return (w.tokens?.length||0)*5000 + Math.min(w.rediscoveryCount||0,1000)*10 + Math.min(w.profile?.heliusRecent?.swapsFetched||0,50); }
function fingerprint(w:Wallet){ return `${EVALUATOR_VERSION}|${(w.tokens||[]).slice().sort().join(",")}|${(w.tags||[]).slice().sort().join(",")}|${w.status||""}`; }
function badTag(tags:string[]=[]){ const s=tags.join(" ").toLowerCase(); for(const x of ["sniper","bundler","insider","developer","bot","mev","exchange","cex"]) if(s.includes(x))return x; return null; }
function sleep(ms:number){ return new Promise(resolve=>setTimeout(resolve,ms)); }
function retryableStatus(status:number){ return status===408||status===425||status===429||status>=500; }
function deadline(started:number){ return Date.now()-started>=TIME_BUDGET_MS; }

const providerStats={heliusCalls:0,vybeCalls:0,retries:0,rateLimits:0,errors:0,cacheHits:0,cacheMisses:0};
async function fetchJson(url:string,init:RequestInit={},attempts=3){
  let last:Error|undefined;
  for(let attempt=0;attempt<attempts;attempt++){
    const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT_MS);
    try{
      const r=await fetch(url,{...init,signal:c.signal});
      const text=await r.text();
      if(r.ok)return text?JSON.parse(text):null;
      if(r.status===429)providerStats.rateLimits++;
      const err=new Error(`${r.status}:${text.slice(0,220)}`); last=err;
      if(!retryableStatus(r.status)||attempt===attempts-1)throw err;
      providerStats.retries++;
      const retryAfter=Number(r.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:650*(2**attempt)+Math.floor(Math.random()*300));
    }catch(e){
      last=e instanceof Error?e:new Error(String(e));
      if(attempt===attempts-1){providerStats.errors++;throw last;}
      providerStats.retries++;
      await sleep(650*(2**attempt)+Math.floor(Math.random()*300));
    }finally{ clearTimeout(t); }
  }
  throw last||new Error("fetch failed");
}
async function atomicSave(file:string,data:any){ await fs.mkdir(path.dirname(file),{recursive:true}); const tmp=`${file}.tmp`; await fs.writeFile(tmp,JSON.stringify(data,null,2)); await fs.rename(tmp,file); }
async function loadCheckpoint():Promise<Checkpoint>{ try{ const x=JSON.parse(await fs.readFile(CHECKPOINT_PATH,"utf8")); return {schemaVersion:6,updatedAt:x.updatedAt||new Date().toISOString(),results:x.results||{},prefilter:x.prefilter||{},runs:Array.isArray(x.runs)?x.runs:[]}; }catch{ return {schemaVersion:6,updatedAt:new Date().toISOString(),results:{},prefilter:{},runs:[]}; } }
async function loadCache():Promise<Cache>{ try{return JSON.parse(await fs.readFile(HELIUS_CACHE_PATH,"utf8"));}catch{return{schemaVersion:1,wallets:{}};} }

let heliusNextAt=0;
async function heliusThrottle(){ const wait=Math.max(0,heliusNextAt-Date.now()); if(wait)await sleep(wait); heliusNextAt=Math.max(Date.now(),heliusNextAt)+HELIUS_MIN_INTERVAL_MS; }
async function heliusPage(address:string,before:string|undefined,swapOnly:boolean,limit=100){
  await heliusThrottle(); providerStats.heliusCalls++;
  const u=new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
  u.searchParams.set("api-key",HELIUS_API_KEY!); u.searchParams.set("limit",String(limit));
  if(before)u.searchParams.set("before",before); if(swapOnly)u.searchParams.set("type","SWAP");
  return fetchJson(u.toString(),{},4);
}
function cacheRows(cache:Cache,address:string){
  const c=cache.wallets?.[address]; if(!c||!Array.isArray(c.rows))return null;
  const age=Date.now()-Date.parse(c.fetchedAt||"");
  if(!Number.isFinite(age)||age>CACHE_MAX_AGE_MIN*60_000)return null;
  providerStats.cacheHits++; return c.rows;
}
async function recentRows(address:string,cache:Cache){
  const c=cacheRows(cache,address); if(c)return{rows:c,error:null,cache:true};
  providerStats.cacheMisses++;
  if(!HELIUS_API_KEY)return{rows:[] as any[],error:"HELIUS_API_KEY missing",cache:false};
  try{const x=await heliusPage(address,undefined,true,50); return{rows:Array.isArray(x)?x:[],error:null,cache:false};}
  catch(e){return{rows:[] as any[],error:String(e),cache:false};}
}
async function heliusHistory(address:string,seed:any[]=[]){
  if(!HELIUS_API_KEY)return{rows:seed,error:"HELIUS_API_KEY missing",partial:true,swapFiltered:false};
  const all=[...seed],seen=new Set(seed.map(x=>x?.signature).filter(Boolean)); let before=seed.length?seed[seed.length-1]?.signature:undefined; let partial=false,swapFiltered=true;
  try{
    for(let page=0;page<HELIUS_PAGES;page++){
      let x:any;
      try{x=await heliusPage(address,before,true,100);}catch(e){
        if(page===0&&String(e).includes("400")){swapFiltered=false;x=await heliusPage(address,before,false,100);} else throw e;
      }
      if(!Array.isArray(x)||!x.length)break;
      let added=0; for(const row of x){if(!row?.signature||!seen.has(row.signature)){all.push(row);if(row?.signature)seen.add(row.signature);added++;}}
      before=x[x.length-1]?.signature;
      if(x.length<100||added===0)break;
      if(page===HELIUS_PAGES-1&&x.length===100)partial=true;
    }
    all.sort((a,b)=>Number(b?.timestamp||0)-Number(a?.timestamp||0));
    return{rows:all,error:null,partial,swapFiltered};
  }catch(e){return{rows:all,error:String(e),partial:true,swapFiltered};}
}
async function vybeTrades(address:string){
  if(!VYBE_API_KEY)return{rows:[] as any[],error:"VYBE_API_KEY missing"};
  try{providerStats.vybeCalls++; const end=Math.floor(Date.now()/1000)-300,start=end-VYBE_LOOKBACK_HOURS*3600; const q=new URLSearchParams({authorityAddress:address,timeStart:String(start),timeEnd:String(end),limit:"500",page:"0",sortByAsc:"blockTime"}); const x=await fetchJson(`https://api.vybenetwork.xyz/v4/trades?${q}`,{headers:{"X-API-Key":VYBE_API_KEY}},3); return{rows:Array.isArray(x?.data)?x.data:[],error:null};}
  catch(e){return{rows:[],error:String(e)};}
}
function num(v:any):number|null { const n=Number(v); return Number.isFinite(n)?n:null; }
function nativeSol(x:any){ const n=num(x?.amount); return n==null?null:n/1e9; }
function followerEconomics(sourceRoi:number|null,retention=1){ if(sourceRoi==null)return{net:null,roi:null}; const buyFee=Math.max(FOLLOW_SIZE*ODIN_RATE,0.001),buyTip=FOLLOW_SIZE*TIP_RATE,buyTotal=FOLLOW_SIZE+buyFee+buyTip+NETWORK_PER_LEG; const grossExit=Math.max(0,FOLLOW_SIZE*(1+sourceRoi*retention)); const sellFee=Math.max(grossExit*ODIN_RATE,0.001),sellTip=grossExit*TIP_RATE,netExit=grossExit-sellFee-sellTip-NETWORK_PER_LEG,net=netExit-buyTotal; return{net,roi:net/buyTotal}; }
function quoteSolFromTransfers(tx:any,wallet:string,direction:"out"|"in"){ let total=0,seen=false; for(const x of tx?.nativeTransfers||[]){const hit=direction==="out"?x?.fromUserAccount===wallet:x?.toUserAccount===wallet;if(hit){const v=nativeSol(x);if(v!=null){total+=v;seen=true;}}} for(const x of tx?.tokenTransfers||[]){if(x?.mint!==WSOL)continue;const hit=direction==="out"?x?.fromUserAccount===wallet:x?.toUserAccount===wallet;if(hit){const v=num(x?.tokenAmount);if(v!=null){total+=v;seen=true;}}} return seen?total:null; }
function extractTrade(tx:any,wallet:string){
  const buys:Array<{mint:string;qty:number|null}>=[],sells:Array<{mint:string;qty:number|null}>=[]; const ev=tx?.events?.swap;
  if(ev){for(const x of ev.tokenOutputs||[])if(x?.userAccount===wallet&&!QUOTES.has(x?.mint))buys.push({mint:x.mint,qty:num(x?.rawTokenAmount?.tokenAmount??x?.tokenAmount)});for(const x of ev.tokenInputs||[])if(x?.userAccount===wallet&&!QUOTES.has(x?.mint))sells.push({mint:x.mint,qty:num(x?.rawTokenAmount?.tokenAmount??x?.tokenAmount)});}
  if(!buys.length&&!sells.length){for(const x of tx?.tokenTransfers||[]){if(!x?.mint||QUOTES.has(x.mint))continue;const q=num(x?.tokenAmount);if(x?.toUserAccount===wallet&&x?.fromUserAccount!==wallet)buys.push({mint:x.mint,qty:q});if(x?.fromUserAccount===wallet&&x?.toUserAccount!==wallet)sells.push({mint:x.mint,qty:q});}}
  const nativeInput=nativeSol(ev?.nativeInput),nativeOutput=nativeSol(ev?.nativeOutput); return{buys,sells,buyQuoteSol:nativeInput??quoteSolFromTransfers(tx,wallet,"out"),sellQuoteSol:nativeOutput??quoteSolFromTransfers(tx,wallet,"in")};
}
function holds(rows:any[],wallet:string){
  const ordered=[...rows].filter(x=>Number.isFinite(Number(x?.timestamp))).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)); const open=new Map<string,Lot[]>(),rts:RoundTrip[]=[]; let buys=0,sells=0,parsedSwaps=0;
  for(const tx of ordered){const t=Number(tx.timestamp),ex=extractTrade(tx,wallet);if(!ex.buys.length&&!ex.sells.length)continue;parsedSwaps++;
    for(const b of ex.buys){buys++;const a=open.get(b.mint)||[];a.push({t,qty:b.qty,buySol:ex.buys.length===1?ex.buyQuoteSol:null});open.set(b.mint,a);}
    for(const s of ex.sells){sells++;const a=open.get(s.mint)||[];if(!a.length)continue;let remaining=s.qty;while(a.length&&(remaining==null||remaining>0)){const lot=a[0]!,lotQty=lot.qty,closeQty=remaining==null||lotQty==null?lotQty:Math.min(remaining,lotQty),fraction=lotQty&&closeQty!=null?Math.min(1,closeQty/lotQty):1,buySol=lot.buySol==null?null:lot.buySol*fraction,sellSol=ex.sells.length===1&&ex.sellQuoteSol!=null?ex.sellQuoteSol*fraction:null,src=buySol&&sellSol!=null?(sellSol-buySol)/buySol:null,full=followerEconomics(src,1),stress50=followerEconomics(src,.5),stress75=followerEconomics(src,.25);rts.push({mint:s.mint,buyTimestamp:lot.t,sellTimestamp:t,holdSeconds:Math.max(0,t-lot.t),buySol,sellSol,sourceRoi:src,followerNetSol:full.net,followerRoi:full.roi,stress50NetSol:stress50.net,stress75NetSol:stress75.net});if(remaining==null||lotQty==null||closeQty==null||closeQty>=lotQty){a.shift();remaining=null;}else{lot.qty=lotQty-closeQty;if(lot.buySol!=null)lot.buySol*=1-fraction;remaining-=closeQty;}}open.set(s.mint,a);}
  }
  const hs=rts.map(x=>x.holdSeconds),fr=rts.map(x=>x.followerRoi).filter((x):x is number=>x!=null),nets=rts.map(x=>x.followerNetSol).filter((x):x is number=>x!=null),n50=rts.map(x=>x.stress50NetSol).filter((x):x is number=>x!=null),n75=rts.map(x=>x.stress75NetSol).filter((x):x is number=>x!=null);
  return{closedHolds:hs.length,medianHoldSeconds:median(hs),p25HoldSeconds:quantile(hs,.25),p75HoldSeconds:quantile(hs,.75),fastUnder10m:hs.filter(x=>x<600).length,slowOver6h:hs.filter(x=>x>=21600).length,idealOver12h:hs.filter(x=>x>=43200).length,buyEvents:buys,sellEvents:sells,parsedSwaps,estimatedFollowerTrades:fr.length,estimatedFollowerWinRate:fr.length?fr.filter(x=>x>0).length/fr.length:null,estimatedFollowerMedianRoi:median(fr),estimatedFollowerNetSol:nets.length?nets.reduce((a,b)=>a+b,0):null,stress50NetSol:n50.length?n50.reduce((a,b)=>a+b,0):null,stress75NetSol:n75.length?n75.reduce((a,b)=>a+b,0):null,roundTrips:rts.slice(-120)};
}
function cappedReplay(rts:RoundTrip[],dailyCap:number){
  const groups=new Map<string,RoundTrip[]>(); for(const r of rts){const k=`${r.mint}|${r.buyTimestamp}`;const a=groups.get(k)||[];a.push(r);groups.set(k,a);} const entries=[...groups.values()].sort((a,b)=>a[0]!.buyTimestamp-b[0]!.buyTimestamp); const daily=new Map<string,number>(),tokenDay=new Set<string>(),tokenWeek=new Set<string>(); let selected=0,net=0,n50=0,n75=0,wins=0;
  for(const g of entries){const first=g[0]!,d=new Date(first.buyTimestamp*1000),day=d.toISOString().slice(0,10),week=`${d.getUTCFullYear()}-${Math.floor((Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-Date.UTC(d.getUTCFullYear(),0,1))/604800000)}`,td=`${first.mint}|${day}`,tw=`${first.mint}|${week}`;if((daily.get(day)||0)>=dailyCap||tokenDay.has(td)||tokenWeek.has(tw))continue;const vals=g.map(x=>x.followerNetSol).filter((x):x is number=>x!=null),s50=g.map(x=>x.stress50NetSol).filter((x):x is number=>x!=null),s75=g.map(x=>x.stress75NetSol).filter((x):x is number=>x!=null);if(!vals.length)continue;const tradeNet=vals.reduce((a,b)=>a+b,0);net+=tradeNet;n50+=s50.reduce((a,b)=>a+b,0);n75+=s75.reduce((a,b)=>a+b,0);if(tradeNet>0)wins++;selected++;daily.set(day,(daily.get(day)||0)+1);tokenDay.add(td);tokenWeek.add(tw);}
  return{dailyCap,selected,netSol:net,stress50NetSol:n50,stress75NetSol:n75,winRate:selected?wins/selected:null};
}
function replay(h:any){return{onePerDay:cappedReplay(h.roundTrips||[],1),twoPerDay:cappedReplay(h.roundTrips||[],2)};}
function robustness(h:any,rp:any){const nets=(h.roundTrips||[]).map((x:any)=>x.followerNetSol).filter((x:any)=>typeof x==="number") as number[],positive=nets.filter(x=>x>0),totalPositive=positive.reduce((a,b)=>a+b,0),largest=positive.length?Math.max(...positive):0;return{positiveTrades:positive.length,largestWinnerShare:totalPositive>0?largest/totalPositive:null,antiJackpotPass:totalPositive>0?largest/totalPositive<=0.6:null,stress50Positive:typeof h.stress50NetSol==="number"?h.stress50NetSol>0:null,capped2Stress50Positive:rp.twoPerDay.selected>=3?rp.twoPerDay.stress50NetSol>0:null};}
function prefilterVerdict(w:Wallet,h:any,error:string|null){const tag=badTag(w.tags);if(tag)return{status:"REJECT",reason:`bad_tag:${tag}`,priority:-999};const med=h.medianHoldSeconds;if(h.closedHolds>=3&&med!=null&&med<600)return{status:"REJECT",reason:"recent_median_under_10m",priority:-500};if(h.closedHolds>=3&&med!=null&&med<3600)return{status:"SIGNAL_ONLY",reason:"recent_median_under_1h",priority:-100};const priority=score(w)+(med!=null?Math.min(med/60,1440):0)+(h.closedHolds>=3?2000:0)+(h.slowOver6h||0)*3000+(h.idealOver12h||0)*5000-(error?2000:0);return{status:"PASS",reason:h.closedHolds?"recent_behavior_viable":"insufficient_recent_closes",priority};}
function dataQuality(h:any,hx:any,vt:any){const holdScore=Math.min(1,h.closedHolds/10),tradeScore=Math.min(1,h.estimatedFollowerTrades/8),coveragePenalty=hx.partial?.15:0,errorPenalty=hx.error?.25:0;return{score:Math.max(0,Math.min(1,.55*holdScore+.35*tradeScore+.10*(vt.rows.length>0?1:0)-coveragePenalty-errorPenalty)),closedHoldAdequate:h.closedHolds>=5,economicSampleAdequate:h.estimatedFollowerTrades>=5,vybeAvailable:vt.rows.length>0,heliusPartial:hx.partial};}
function finalVerdict(w:Wallet,h:any,rp:any,r:any,q:any,errors:string[],partial:boolean){const tag=badTag(w.tags);if(tag)return{status:"REJECT",stage:"hard_gate",reasons:[`bad_tag:${tag}`]};const med=h.medianHoldSeconds,reasons:string[]=[];if(partial)reasons.push("helius_history_window_partial");if(h.closedHolds<5)reasons.push("closed_hold_sample_under_5");if(med==null)reasons.push("hold_time_unknown");else if(med<600)reasons.push("median_hold_under_10m");else if(med<3600)reasons.push("median_hold_10m_to_1h");else if(med<21600)reasons.push("median_hold_1h_to_6h");else if(med<43200)reasons.push("median_hold_6h_plus");else reasons.push("median_hold_12h_plus");if((w.tokens?.length||0)<2)reasons.push("single_discovery_token");else reasons.push(`cross_token_${w.tokens!.length}`);if(errors.length)reasons.push(...errors);
  if(h.closedHolds>=3&&med!=null&&med<600)return{status:"REJECT",stage:"hold_time",reasons};if(h.closedHolds>=3&&med!=null&&med<3600)return{status:"SIGNAL_ONLY",stage:"hold_time",reasons};if(h.estimatedFollowerTrades>=5&&h.estimatedFollowerNetSol!=null&&h.estimatedFollowerNetSol<=0)return{status:"REJECT",stage:"fixed_size_economics",reasons:[...reasons,"0.075_estimated_net_nonpositive"]};if(r.antiJackpotPass===false&&h.estimatedFollowerTrades>=5)return{status:"REJECT",stage:"robustness",reasons:[...reasons,"largest_winner_over_60pct_positive_pnl"]};
  if(med!=null&&med>=21600&&h.closedHolds>=8&&(w.tokens?.length||0)>=2&&rp.twoPerDay.selected>=3&&rp.twoPerDay.netSol>0&&rp.twoPerDay.stress50NetSol>0&&r.antiJackpotPass===true&&q.score>=.55)return{status:"DEEP_DIVE",stage:"odin_capped_replay",reasons:[...reasons,"0.075_two_per_day_replay_positive","anti_jackpot_pass","50pct_alpha_retention_positive","needs_exact_price_lag_liquidity_replay"]};if(med!=null&&med>=3600&&h.closedHolds>=5)return{status:"SIGNAL_ONLY",stage:"needs_more_economic_evidence",reasons};return{status:"UNKNOWN",stage:"insufficient_evidence",reasons};}
function shouldEvaluate(w:Wallet,prev:Result|undefined){if(!prev)return true;if(prev.fingerprint!==fingerprint(w))return true;if(prev.verdict?.status!=="UNKNOWN")return false;const transient=prev.verdict?.stage==="evaluation_error"||Boolean(prev.heliusError)||Boolean(prev.vybeError);if(!transient)return false;const age=Date.now()-Date.parse(prev.evaluatedAt||"");return !Number.isFinite(age)||age>=UNKNOWN_RETRY_HOURS*3600_000;}
async function evaluate(w:Wallet,seed:any[],pre:any):Promise<Result>{const [hx,vt]=await Promise.all([heliusHistory(w.address,seed),vybeTrades(w.address)]),h=holds(hx.rows,w.address),rp=replay(h),r=robustness(h,rp),q=dataQuality(h,hx,vt),errors:string[]=[];if(hx.error)errors.push("helius_history_error");if(vt.error)errors.push("vybe_history_unavailable");const v=finalVerdict(w,h,rp,r,q,errors,hx.partial);return{address:w.address,fingerprint:fingerprint(w),evaluatedAt:new Date().toISOString(),discoveryTokens:w.tokens?.length||0,rediscoveryCount:w.rediscoveryCount||0,providers:w.providers||[],prefilter:pre,heliusTransactions:hx.rows.length,heliusSwaps:hx.rows.filter(x=>x?.type==="SWAP").length,heliusCoveragePartial:hx.partial,heliusError:hx.error,vybeTradesWindow:vt.rows.length,vybeLookbackHours:VYBE_LOOKBACK_HOURS,vybeError:vt.error,hold:h,replay:rp,robustness:r,dataQuality:q,verdict:v};}
function failedResult(w:Wallet,e:unknown,pre:any):Result{const msg=e instanceof Error?e.message:String(e),h={closedHolds:0,medianHoldSeconds:null,roundTrips:[],estimatedFollowerTrades:0};return{address:w.address,fingerprint:fingerprint(w),evaluatedAt:new Date().toISOString(),discoveryTokens:w.tokens?.length||0,rediscoveryCount:w.rediscoveryCount||0,providers:w.providers||[],prefilter:pre,heliusTransactions:0,heliusSwaps:0,heliusCoveragePartial:true,heliusError:msg,vybeTradesWindow:0,vybeLookbackHours:VYBE_LOOKBACK_HOURS,vybeError:null,hold:h,replay:{onePerDay:{selected:0,netSol:0},twoPerDay:{selected:0,netSol:0}},robustness:{},dataQuality:{score:0},verdict:{status:"UNKNOWN",stage:"evaluation_error",reasons:["wallet_evaluation_exception"]}};}

export async function runGauntlet(){
  const wallStart=Date.now(),startedAt=new Date().toISOString(),state=JSON.parse(await fs.readFile(STATE_PATH,"utf8")),cp=await loadCheckpoint(),cache=await loadCache();
  const eligible=(Object.values(state.wallets||{}) as Wallet[]).filter(w=>w.status!=="REJECTED").sort((a,b)=>score(b)-score(a));
  const pending=eligible.filter(w=>shouldEvaluate(w,cp.results[w.address])); const preBatch=pending.slice(0,PREFILTER_LIMIT); const passed:Array<{w:Wallet;rows:any[];pre:any}>=[]; let prefiltered=0,preRejected=0,preSignal=0;
  for(const w of preBatch){if(deadline(wallStart))break;const rr=await recentRows(w.address,cache),h=holds(rr.rows,w.address),pv=prefilterVerdict(w,h,rr.error),pre={evaluatedAt:new Date().toISOString(),status:pv.status,reason:pv.reason,priority:pv.priority,closedHolds:h.closedHolds,medianHoldSeconds:h.medianHoldSeconds,recentRows:rr.rows.length,cacheHit:rr.cache,error:rr.error};cp.prefilter[w.address]=pre;prefiltered++;if(pv.status==="REJECT"){preRejected++;continue;}if(pv.status==="SIGNAL_ONLY"){preSignal++;continue;}passed.push({w,rows:rr.rows,pre});}
  passed.sort((a,b)=>(b.pre.priority||0)-(a.pre.priority||0)); const full=passed.slice(0,FULL_LIMIT); let completedThisRun=0;
  for(let i=0;i<full.length&&!deadline(wallStart);i+=CONCURRENCY){const wave=full.slice(i,i+CONCURRENCY),results=await Promise.all(wave.map(async x=>{try{return await evaluate(x.w,x.rows,x.pre);}catch(e){return failedResult(x.w,e,x.pre);}}));for(const r of results)cp.results[r.address]=r;completedThisRun+=results.length;cp.updatedAt=new Date().toISOString();await atomicSave(CHECKPOINT_PATH,cp);}
  const current=eligible.map(w=>cp.results[w.address]).filter((x):x is Result=>Boolean(x)&&x.fingerprint.startsWith(`${EVALUATOR_VERSION}|`));const counts=current.reduce((a:any,x:any)=>(a[x.verdict.status]=(a[x.verdict.status]||0)+1,a),{}),deep=current.filter(x=>x.verdict.status==="DEEP_DIVE").sort((a,b)=>(b.replay?.twoPerDay?.stress50NetSol||-999)-(a.replay?.twoPerDay?.stress50NetSol||-999));const remaining=eligible.filter(w=>shouldEvaluate(w,cp.results[w.address])).length;const elapsedMs=Date.now()-wallStart;
  const runSummary={startedAt,finishedAt:new Date().toISOString(),evaluatorVersion:EVALUATOR_VERSION,eligible:eligible.length,pendingAtStart:pending.length,prefiltered,preRejected,preSignal,prePassed:passed.length,fullEvaluated:completedThisRun,processedCumulative:current.length,remaining,counts,elapsedMs,timeBudgetMs:TIME_BUDGET_MS,providerStats};cp.runs=[...cp.runs.slice(-99),runSummary];cp.updatedAt=new Date().toISOString();await atomicSave(CHECKPOINT_PATH,cp);
  const report={schemaVersion:6,generatedAt:new Date().toISOString(),...runSummary,note:"v5 staged copyability gauntlet: cached/recent prefilter -> prioritized full reconstruction -> Odin 0.075 SOL capped replay. DEEP_DIVE still requires exact source-to-copy price/lag/liquidity/slippage validation before LIVE-TEST WORTHY.",deepDive:deep.slice(0,25),results:current};await atomicSave(REPORT_PATH,report);
  console.log(JSON.stringify({event:"shark_scout_gauntlet_complete",generatedAt:report.generatedAt,evaluatorVersion:EVALUATOR_VERSION,prefiltered,preRejected,preSignal,prePassed:passed.length,processedThisRun:completedThisRun,processedCumulative:current.length,remaining,elapsedMs,providerStats,counts,deepDive:deep.slice(0,10).map(x=>({address:x.address,medianHoldSeconds:x.hold.medianHoldSeconds,closedHolds:x.hold.closedHolds,discoveryTokens:x.discoveryTokens,replay2DayNetSol:x.replay.twoPerDay.netSol,replay2DayStress50NetSol:x.replay.twoPerDay.stress50NetSol,replay2DayTrades:x.replay.twoPerDay.selected,largestWinnerShare:x.robustness.largestWinnerShare,dataQuality:x.dataQuality.score,reasons:x.verdict.reasons}))}));return report;
}
if(import.meta.url===`file://${process.argv[1]}`)runGauntlet().catch(e=>{console.error(JSON.stringify({event:"shark_scout_gauntlet_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
