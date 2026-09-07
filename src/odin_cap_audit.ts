import { promises as fs } from "node:fs";
import path from "node:path";

const CP_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"./data/gauntlet-state.json";
const OUT_PATH=process.env.SCOUT_ODIN_CAP_AUDIT_PATH||"./data/odin-cap-audit.json";
const FOCUS=(process.env.ODIN_CAP_AUDIT_FOCUS||"ianCETBFexGgK8TA3gSLeAaNiLMsJPgUN1H44jhxQtB").split(",").map(x=>x.trim()).filter(Boolean);
const MAX_WALLETS=Math.max(5,Math.min(100,Number(process.env.ODIN_CAP_AUDIT_MAX_WALLETS||40)));
const HOURLY_CAP=Math.max(1,Math.min(10,Number(process.env.ODIN_CAP_AUDIT_HOURLY_CAP||1)));
const TOKEN_DAY_CAP=Math.max(1,Math.min(10,Number(process.env.ODIN_CAP_AUDIT_TOKEN_DAY_CAP||1)));
const TOKEN_WEEK_CAP=Math.max(1,Math.min(10,Number(process.env.ODIN_CAP_AUDIT_TOKEN_WEEK_CAP||1)));

type AnyObj=Record<string,any>;
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function ts(x:any){const raw=x?.buyTimestamp;if(typeof raw==="number"&&Number.isFinite(raw))return raw>1e12?Math.floor(raw/1000):raw;const asNum=Number(raw);if(Number.isFinite(asNum)&&asNum>0)return asNum>1e12?Math.floor(asNum/1000):asNum;const parsed=Date.parse(String(raw||""));return Number.isFinite(parsed)?Math.floor(parsed/1000):0;}
function isoWeekKey(sec:number){const d=new Date(sec*1000),u=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));const day=u.getUTCDay()||7;u.setUTCDate(u.getUTCDate()+4-day);const y0=new Date(Date.UTC(u.getUTCFullYear(),0,1));const week=Math.ceil((((u.getTime()-y0.getTime())/86400000)+1)/7);return `${u.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;}
function tripKey(x:any){return `${x?.mint||"?"}|${ts(x)}|${x?.buySignature||"?"}`;}
function dedupe(trips:any[]){const m=new Map<string,any>();for(const x of trips||[]){if(!x||n(x?.followerNetSol)==null||ts(x)<=0)continue;m.set(tripKey(x),x);}return [...m.values()].sort((a,b)=>ts(a)-ts(b));}
function simulate(trips:any[],dailyCap:number){const dayCount=new Map<string,number>(),hourCount=new Map<string,number>(),tokenDay=new Map<string,number>(),tokenWeek=new Map<string,number>();const selected:any[]=[];let skippedDaily=0,skippedHourly=0,skippedTokenDay=0,skippedTokenWeek=0;
  for(const x of trips){const t=ts(x);if(!t)continue;const d=new Date(t*1000),day=d.toISOString().slice(0,10),hour=d.toISOString().slice(0,13),mint=String(x?.mint||"?"),week=isoWeekKey(t),td=`${mint}|${day}`,tw=`${mint}|${week}`;
    if((dayCount.get(day)||0)>=dailyCap){skippedDaily++;continue;}if((hourCount.get(hour)||0)>=HOURLY_CAP){skippedHourly++;continue;}if((tokenDay.get(td)||0)>=TOKEN_DAY_CAP){skippedTokenDay++;continue;}if((tokenWeek.get(tw)||0)>=TOKEN_WEEK_CAP){skippedTokenWeek++;continue;}
    selected.push(x);dayCount.set(day,(dayCount.get(day)||0)+1);hourCount.set(hour,(hourCount.get(hour)||0)+1);tokenDay.set(td,(tokenDay.get(td)||0)+1);tokenWeek.set(tw,(tokenWeek.get(tw)||0)+1);
  }
  const nets=selected.map(x=>n(x?.followerNetSol)).filter((x):x is number=>x!=null),s50=selected.map(x=>n(x?.stress50NetSol)).filter((x):x is number=>x!=null),s75=selected.map(x=>n(x?.stress75NetSol)).filter((x):x is number=>x!=null),wins=nets.filter(x=>x>0),grossWins=sum(wins),largest=wins.length?Math.max(...wins):0;
  return{dailyCap,selected:nets.length,netSol:sum(nets),stress50NetSol:sum(s50),stress75NetSol:sum(s75),winRate:nets.length?wins.length/nets.length:null,largestWinnerShare:grossWins>0?largest/grossWins:null,skipped:{daily:skippedDaily,hourly:skippedHourly,tokenDay:skippedTokenDay,tokenWeek:skippedTokenWeek}};
}
function marginal(a:any,b:any){return{extraTrades:b.selected-a.selected,extraNetSol:b.netSol-a.netSol,extraStress50NetSol:b.stress50NetSol-a.stress50NetSol,extraStress75NetSol:b.stress75NetSol-a.stress75NetSol};}
function recommend(one:any,two:any,three:any){const m12=marginal(one,two),m23=marginal(two,three);let dailyCap=1,confidence="HOLD",reasons:string[]=[];
  if(two.selected>=5&&m12.extraTrades>=2&&m12.extraNetSol>0&&m12.extraStress50NetSol>0&&m12.extraStress75NetSol>0){dailyCap=2;confidence="HISTORICALLY_SUPPORTED";reasons.push("second_daily_slot_positive_base_stress50_stress75");}else reasons.push("second_daily_slot_not_robustly_positive");
  if(dailyCap===2&&m23.extraTrades>=5&&m23.extraNetSol>0&&m23.extraStress50NetSol>0&&m23.extraStress75NetSol>0)reasons.push("third_slot_positive_but_requires_prospective_validation");else reasons.push("third_slot_not_approved");
  return{dailyCap,confidence,reasons,marginal1to2:m12,marginal2to3:m23};
}
async function main(){const startedAt=new Date().toISOString(),cp=await read(CP_PATH,{results:{}}),all=Object.entries(cp?.results||{}).map(([address,r0])=>{const r=r0 as AnyObj,tr=dedupe(Array.isArray(r?.canonicalReplay?.roundTrips)?r.canonicalReplay.roundTrips:[]);return{address,r,tr,status:String(r?.canonicalOverlay?.status||"UNKNOWN")};}).filter(x=>x.tr.length>0);all.sort((a,b)=>Number(FOCUS.includes(b.address))-Number(FOCUS.includes(a.address))||b.tr.length-a.tr.length);const rows=all.slice(0,MAX_WALLETS).map(x=>{const one=simulate(x.tr,1),two=simulate(x.tr,2),three=simulate(x.tr,3);return{address:x.address,focused:FOCUS.includes(x.address),canonicalStatus:x.status,canonicalTrades:x.tr.length,policy:{hourlyCap:HOURLY_CAP,tokenDayCap:TOKEN_DAY_CAP,tokenWeekCap:TOKEN_WEEK_CAP,tradeSizeSol:0.075},cap1:one,cap2:two,cap3:three,recommendation:recommend(one,two,three)};});const out={schemaVersion:1,event:"shark_scout_odin_cap_audit_complete",startedAt,finishedAt:new Date().toISOString(),walletsExamined:rows.length,focusWallets:FOCUS,rows,notes:["Counterfactual is chronological first-eligible opportunity selection using canonical round trips only.","It models daily/hourly/token-day/token-week caps but cannot recreate opportunities absent from canonical history.","Recommendation is historical evidence only; prospective Paper Odin/live follower evidence remains required before sizing increases or a third daily slot.","This module never changes Odin settings or capital."]};await atomic(OUT_PATH,out);console.log(JSON.stringify(out));}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_odin_cap_audit_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
