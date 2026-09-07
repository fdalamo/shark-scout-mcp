import { promises as fs } from "node:fs";
import path from "node:path";

const CP_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"./data/gauntlet-state.json";
const CACHE_DIR=process.env.SCOUT_HELIUS_CACHE_DIR||"./data/helius-cache";
const OUT_PATH=process.env.SCOUT_REPLAY_SHADOW_PATH||"./data/replay-shadow.json";
const MAX_WALLETS=Math.max(5,Math.min(80,Number(process.env.REPLAY_SHADOW_MAX_WALLETS||30)));
const FOLLOW_SIZE=.075,ODIN_RATE=.01,TIP_RATE=.003,NETWORK_PER_LEG=.00015;
const WSOL="So11111111111111111111111111111111111111112",USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",USDT="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const QUOTES=new Set([WSOL,USDC,USDT]);

type Lot={t:number;qty:number;buySol:number|null};
type RT={mint:string;buyTimestamp:number;sellTimestamp:number;holdSeconds:number;buySol:number|null;sellSol:number|null;sourceRoi:number|null;followerNetSol:number|null;followerRoi:number|null;stress50NetSol:number|null;stress75NetSol:number|null;evidence:string};

function num(v:any){const n=Number(v);return Number.isFinite(n)?n:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
function median(xs:number[]){if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;}
async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function econ(sourceRoi:number|null,retention=1){if(sourceRoi==null)return{net:null,roi:null};const bf=Math.max(FOLLOW_SIZE*ODIN_RATE,.001),bt=FOLLOW_SIZE*TIP_RATE,cost=FOLLOW_SIZE+bf+bt+NETWORK_PER_LEG,gross=Math.max(0,FOLLOW_SIZE*(1+sourceRoi*retention)),sf=Math.max(gross*ODIN_RATE,.001),st=gross*TIP_RATE,net=gross-sf-st-NETWORK_PER_LEG-cost;return{net,roi:net/cost};}
function rawAmount(x:any){const raw=num(x?.rawTokenAmount?.tokenAmount??x?.tokenAmount);if(raw==null)return null;const d=num(x?.rawTokenAmount?.decimals);return d==null?raw:raw/10**d;}

function accountDeltas(tx:any,wallet:string){
  const token=new Map<string,number>();let native=0,nativeSeen=false,tokenChanges=0;
  for(const ad of tx?.accountData||[]){
    if(ad?.account===wallet){const d=num(ad?.nativeBalanceChange);if(d!=null){native+=d/1e9;nativeSeen=true;}}
    for(const tb of ad?.tokenBalanceChanges||[]){if(tb?.userAccount!==wallet||!tb?.mint)continue;const q=rawAmount(tb);if(q==null||Math.abs(q)<1e-18)continue;token.set(tb.mint,(token.get(tb.mint)||0)+q);tokenChanges++;}
  }
  return{token,native:nativeSeen?native:null,tokenChanges};
}
function eventFallback(tx:any,wallet:string){const ev=tx?.events?.swap;if(!ev)return null;const pos=new Map<string,number>(),neg=new Map<string,number>();for(const x of ev?.tokenOutputs||[]){if(x?.userAccount!==wallet||!x?.mint)continue;const q=rawAmount(x);if(q!=null)pos.set(x.mint,(pos.get(x.mint)||0)+Math.abs(q));}for(const x of ev?.tokenInputs||[]){if(x?.userAccount!==wallet||!x?.mint)continue;const q=rawAmount(x);if(q!=null)neg.set(x.mint,(neg.get(x.mint)||0)+Math.abs(q));}const ni=num(ev?.nativeInput?.amount),no=num(ev?.nativeOutput?.amount);return{pos,neg,buySol:ni==null?null:ni/1e9,sellSol:no==null?null:no/1e9};}
function extract(tx:any,wallet:string){
  const swapLike=String(tx?.type||"").toUpperCase()==="SWAP"||Boolean(tx?.events?.swap);if(!swapLike)return null;
  const d=accountDeltas(tx,wallet),pos:[string,number][]=[],neg:[string,number][]=[],quoteDelta=(d.token.get(WSOL)||0)+(d.native||0);
  for(const [mint,q] of d.token){if(QUOTES.has(mint)||Math.abs(q)<1e-18)continue;(q>0?pos:neg).push([mint,Math.abs(q)]);}
  if(pos.length===1&&neg.length===0&&quoteDelta<-.0003)return{side:"BUY" as const,mint:pos[0]![0],qty:pos[0]![1],quoteSol:-quoteDelta,evidence:"account_delta"};
  if(neg.length===1&&pos.length===0&&quoteDelta>.0003)return{side:"SELL" as const,mint:neg[0]![0],qty:neg[0]![1],quoteSol:quoteDelta,evidence:"account_delta"};
  const f=eventFallback(tx,wallet);if(!f)return null;const fp=[...f.pos].filter(([m])=>!QUOTES.has(m)),fn=[...f.neg].filter(([m])=>!QUOTES.has(m));
  if(fp.length===1&&fn.length===0&&f.buySol!=null)return{side:"BUY" as const,mint:fp[0]![0],qty:fp[0]![1],quoteSol:f.buySol,evidence:"event_fallback"};
  if(fn.length===1&&fp.length===0&&f.sellSol!=null)return{side:"SELL" as const,mint:fn[0]![0],qty:fn[0]![1],quoteSol:f.sellSol,evidence:"event_fallback"};
  return null;
}
function replay(rows:any[],wallet:string){
  const ordered=[...rows].filter(x=>Number.isFinite(Number(x?.timestamp))).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)),open=new Map<string,Lot[]>(),rts:RT[]=[];let classified=0,accountDelta=0,eventFallbacks=0,ambiguous=0;
  for(const tx of ordered){if(!(String(tx?.type||"").toUpperCase()==="SWAP"||tx?.events?.swap))continue;const ex=extract(tx,wallet);if(!ex){ambiguous++;continue;}classified++;if(ex.evidence==="account_delta")accountDelta++;else eventFallbacks++;const t=Number(tx.timestamp);
    if(ex.side==="BUY"){const a=open.get(ex.mint)||[];a.push({t,qty:ex.qty,buySol:ex.quoteSol});open.set(ex.mint,a);continue;}
    const a=open.get(ex.mint)||[];let remaining=ex.qty,totalQty=ex.qty;while(a.length&&remaining>1e-18){const lot=a[0]!,take=Math.min(remaining,lot.qty),frac=take/lot.qty,sellFrac=totalQty>0?take/totalQty:0,buySol=lot.buySol==null?null:lot.buySol*frac,sellSol=ex.quoteSol*sellFrac,src=buySol&&buySol>0?(sellSol-buySol)/buySol:null,e1=econ(src,1),e5=econ(src,.5),e25=econ(src,.25);rts.push({mint:ex.mint,buyTimestamp:lot.t,sellTimestamp:t,holdSeconds:Math.max(0,t-lot.t),buySol,sellSol,sourceRoi:src,followerNetSol:e1.net,followerRoi:e1.roi,stress50NetSol:e5.net,stress75NetSol:e25.net,evidence:ex.evidence});remaining-=take;if(take>=lot.qty-1e-18)a.shift();else{lot.qty-=take;if(lot.buySol!=null)lot.buySol*=1-frac;}}
    open.set(ex.mint,a);
  }
  const nets=rts.map(x=>x.followerNetSol).filter((x):x is number=>x!=null),s50=rts.map(x=>x.stress50NetSol).filter((x):x is number=>x!=null),rois=rts.map(x=>x.followerRoi).filter((x):x is number=>x!=null);
  return{roundTrips:rts,trades:nets.length,netSol:nets.length?sum(nets):null,stress50NetSol:s50.length?sum(s50):null,winRate:nets.length?nets.filter(x=>x>0).length/nets.length:null,medianRoi:median(rois),classified,accountDelta,eventFallbacks,ambiguous};
}
function oldReplay(r:any){const trips=Array.isArray(r?.hold?.roundTrips)?r.hold.roundTrips:[],nets=trips.map((x:any)=>num(x?.followerNetSol)).filter((x:any):x is number=>x!=null);return{trades:nets.length,netSol:nets.length?sum(nets):null};}

async function main(){
  const startedAt=new Date().toISOString(),cp=await readJson(CP_PATH,{results:{}}),cands=Object.entries(cp?.results||{}).map(([address,r0])=>{const r:any=r0,o=oldReplay(r),closed=Number(r?.hold?.closedHolds||0),buys=Number(r?.hold?.buyEvents||0),med=Number(r?.hold?.medianHoldSeconds||0),coverage=buys>0?Math.min(1,closed/buys):0;return{address,r,o,closed,buys,med,coverage};}).filter(x=>x.closed>=10&&x.med>=3600).sort((a,b)=>(a.o.trades-b.o.trades)||b.coverage-a.coverage||b.closed-a.closed).slice(0,MAX_WALLETS);
  const rows:any[]=[];for(const c of cands){const cache=await readJson(path.join(CACHE_DIR,`${c.address}.json`),{rows:[]}),raw=Array.isArray(cache?.rows)?cache.rows:[],shadow=replay(raw,c.address),delta=shadow.trades-c.o.trades;rows.push({address:c.address,medianHoldHours:c.med/3600,closed:c.closed,buys:c.buys,coverage:c.coverage,historyRows:raw.length,oldReplay:c.o,shadowReplay:{trades:shadow.trades,netSol:shadow.netSol,stress50NetSol:shadow.stress50NetSol,winRate:shadow.winRate,medianRoi:shadow.medianRoi},diagnostics:{classified:shadow.classified,accountDelta:shadow.accountDelta,eventFallbacks:shadow.eventFallbacks,ambiguous:shadow.ambiguous},tradeDelta:delta,classification:shadow.trades>=10&&c.o.trades===0?"ZERO_REPLAY_RECOVERED":shadow.trades>c.o.trades?"MORE_REPLAY_FOUND":shadow.trades<c.o.trades?"REPLAY_DISAGREEMENT_LOWER":"AGREES_OR_NO_CHANGE"});}
  const recovered=rows.filter(x=>x.classification==="ZERO_REPLAY_RECOVERED"),more=rows.filter(x=>x.classification==="MORE_REPLAY_FOUND"),lower=rows.filter(x=>x.classification==="REPLAY_DISAGREEMENT_LOWER");const out={schemaVersion:1,event:"shark_scout_replay_shadow_complete",startedAt,finishedAt:new Date().toISOString(),walletsExamined:rows.length,zeroReplayRecovered:recovered.length,moreReplayFound:more.length,lowerReplayDisagreements:lower.length,topRecovered:recovered.sort((a,b)=>Number(b.shadowReplay.netSol||-999)-Number(a.shadowReplay.netSol||-999)).slice(0,10),largestDisagreements:rows.sort((a,b)=>Math.abs(b.tradeDelta)-Math.abs(a.tradeDelta)).slice(0,10),rows,notes:["Shadow-only diagnostic: does not alter gauntlet verdicts or promotion eligibility.","Canonical path prefers wallet-owned accountData balance deltas; Helius swap events are fallback enrichment.","Unfiltered non-swap transfers are never classified as buys or sells."]};await atomic(OUT_PATH,out);console.log(JSON.stringify(out));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_replay_shadow_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
