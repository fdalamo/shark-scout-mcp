import { promises as fs } from "node:fs";
import path from "node:path";
import { replayEnhancedRows } from "./replay_core.js";

const CP_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"./data/gauntlet-state.json";
const CACHE_DIR=process.env.SCOUT_HELIUS_CACHE_DIR||"./data/helius-cache";
const OUT_PATH=process.env.SCOUT_REPLAY_SHADOW_PATH||"./data/replay-shadow.json";
const MAX_WALLETS=Math.max(5,Math.min(80,Number(process.env.REPLAY_SHADOW_MAX_WALLETS||30)));
const FOCUS=(process.env.REPLAY_SHADOW_FOCUS||"").split(",").map(x=>x.trim()).filter(Boolean);

function num(v:any){const n=Number(v);return Number.isFinite(n)?n:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function oldReplay(r:any){const trips=Array.isArray(r?.hold?.roundTrips)?r.hold.roundTrips:[],nets=trips.map((x:any)=>num(x?.followerNetSol)).filter((x:any):x is number=>x!=null);return{trades:nets.length,netSol:nets.length?sum(nets):null};}

async function main(){
  const startedAt=new Date().toISOString(),cp=await readJson(CP_PATH,{results:{}});
  const all=Object.entries(cp?.results||{}).map(([address,r0])=>{const r:any=r0,o=oldReplay(r),closed=Number(r?.hold?.closedHolds||0),buys=Number(r?.hold?.buyEvents||0),med=Number(r?.hold?.medianHoldSeconds||0),coverage=buys>0?Math.min(1,closed/buys):0,contexts=Number(r?.discoveryTokens||0),risk=String(r?.dataQuality?.risk||"");return{address,r,o,closed,buys,med,coverage,contexts,risk};}).filter(x=>x.closed>=10&&x.med>=3600);
  // Multi-context, well-covered zero-replay wallets are more informative than simply
  // choosing the wallets with the largest closed-trade count. Explicit focus wallets
  // are always included so known diagnostic cases cannot fall out of a top-N sort.
  all.sort((a,b)=>(a.o.trades-b.o.trades)||b.contexts-a.contexts||b.coverage-a.coverage||b.med-a.med||b.closed-a.closed);
  const picked:any[]=[],seen=new Set<string>();
  for(const a of FOCUS.map(addr=>all.find(x=>x.address===addr)).filter(Boolean) as any[]){if(!seen.has(a.address)){picked.push(a);seen.add(a.address);}}
  for(const a of all){if(picked.length>=MAX_WALLETS)break;if(!seen.has(a.address)){picked.push(a);seen.add(a.address);}}
  const rows:any[]=[];
  for(const c of picked){
    const cache=await readJson(path.join(CACHE_DIR,`${c.address}.json`),{rows:[]}),history=Array.isArray(cache?.rows)?cache.rows:[],shadow=replayEnhancedRows(history,c.address),delta=shadow.trusted.trades-c.o.trades;
    const classification=shadow.trusted.trades>=10&&c.o.trades===0?"ZERO_REPLAY_RECOVERED_TRUSTED":shadow.trusted.trades>c.o.trades?"MORE_TRUSTED_REPLAY_FOUND":shadow.trusted.trades<c.o.trades?"TRUSTED_REPLAY_LOWER":"AGREES_OR_NO_CHANGE";
    const suspicious=shadow.diagnostics.economicOutliers>0||shadow.raw.netSol!=null&&shadow.trusted.netSol!=null&&Math.abs(shadow.raw.netSol-shadow.trusted.netSol)>1;
    rows.push({address:c.address,focused:FOCUS.includes(c.address),medianHoldHours:c.med/3600,closed:c.closed,buys:c.buys,coverage:c.coverage,discoveryContexts:c.contexts,dataQualityRisk:c.risk,historyRows:history.length,historyComplete:Boolean(cache?.historyComplete),oldReplay:c.o,shadowReplay:{raw:shadow.raw,trusted:shadow.trusted},diagnostics:shadow.diagnostics,tradeDelta:delta,classification,suspiciousEconomics:suspicious,investigateSignatures:shadow.roundTrips.filter(x=>x.flags.length||!x.trusted).slice(0,20).map(x=>({buy:x.buySignature,sell:x.sellSignature,mint:x.mint,sourceRoi:x.sourceRoi,trusted:x.trusted,flags:x.flags,buyQuote:x.buyQuote,sellQuote:x.sellQuote,evidence:x.evidence}))});
  }
  const recovered=rows.filter(x=>x.classification==="ZERO_REPLAY_RECOVERED_TRUSTED"),more=rows.filter(x=>x.classification==="MORE_TRUSTED_REPLAY_FOUND"),lower=rows.filter(x=>x.classification==="TRUSTED_REPLAY_LOWER"),suspicious=rows.filter(x=>x.suspiciousEconomics);
  const out={schemaVersion:3,event:"shark_scout_replay_shadow_complete",startedAt,finishedAt:new Date().toISOString(),walletsExamined:rows.length,focusWallets:FOCUS,zeroReplayRecoveredTrusted:recovered.length,moreTrustedReplayFound:more.length,lowerTrustedReplayDisagreements:lower.length,suspiciousEconomicsCount:suspicious.length,topRecovered:recovered.sort((a,b)=>Number(b.shadowReplay.trusted.netSol||-999)-Number(a.shadowReplay.trusted.netSol||-999)).slice(0,10),largestDisagreements:[...rows].sort((a,b)=>Math.abs(b.tradeDelta)-Math.abs(a.tradeDelta)).slice(0,10),suspiciousEconomics:suspicious.slice(0,10),rows,notes:["Shadow-only diagnostic: never changes gauntlet verdicts or promotion eligibility.","Candidate selection prioritizes zero-replay, multi-context, high-coverage wallets; explicit focus wallets bypass ranking truncation.","Economics require compatible quote assets on both legs; token-to-token and quote-mismatch trades never fabricate SOL PnL.","Native SOL deltas are fee-neutralized only when the wallet is proven fee payer; WSOL and native SOL are canonicalized as one quote.","Extreme uncorroborated source ROI is retained in raw audit output but quarantined from trusted replay.","Every non-trusted/outlier replay exposes transaction signatures and quote provenance for manual or provider cross-validation."]};
  await atomic(OUT_PATH,out);console.log(JSON.stringify(out));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_replay_shadow_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
