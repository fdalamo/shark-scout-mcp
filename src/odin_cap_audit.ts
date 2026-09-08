import { promises as fs } from "node:fs";
import path from "node:path";

const CP_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"./data/gauntlet-state.json";
const OUT_PATH=process.env.SCOUT_ODIN_CAP_AUDIT_PATH||"./data/odin-cap-audit.json";
const IAN="ianCETBFexGgK8TA3gSLeAaNiLMsJPgUN1H44jhxQtB";
const SIX_MZ="6mzEFZ458A6qcaQLgtBuYYaGJ1qN5tz2Wsr6PC1fLFzx";
const FOCUS=(process.env.ODIN_CAP_AUDIT_FOCUS||`${IAN},${SIX_MZ}`).split(",").map(x=>x.trim()).filter(Boolean);
const MAX_WALLETS=Math.max(5,Math.min(100,Number(process.env.ODIN_CAP_AUDIT_MAX_WALLETS||40)));
const DEFAULT_HOURLY_CAP=Math.max(1,Math.min(10,Number(process.env.ODIN_CAP_AUDIT_HOURLY_CAP||1)));
const DEFAULT_TOKEN_DAY_CAP=Math.max(1,Math.min(10,Number(process.env.ODIN_CAP_AUDIT_TOKEN_DAY_CAP||1)));
const DEFAULT_TOKEN_WEEK_CAP=Math.max(1,Math.min(10,Number(process.env.ODIN_CAP_AUDIT_TOKEN_WEEK_CAP||1)));

type AnyObj=Record<string,any>;
type Policy={hourlyCap:number;tokenDayCap:number;tokenWeekCap:number;tradeSizeSol:number;liveDailyCap:number;shadowDailyCaps:number[];minMarketCapUsd:number|null;newPositionOnly:boolean};
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function policyFor(address:string):Policy{
  if(address===IAN)return{hourlyCap:1,tokenDayCap:1,tokenWeekCap:1,tradeSizeSol:.075,liveDailyCap:1,shadowDailyCaps:[2,3],minMarketCapUsd:100000,newPositionOnly:true};
  if(address===SIX_MZ)return{hourlyCap:2,tokenDayCap:1,tokenWeekCap:1,tradeSizeSol:.075,liveDailyCap:2,shadowDailyCaps:[3],minMarketCapUsd:500000,newPositionOnly:true};
  return{hourlyCap:DEFAULT_HOURLY_CAP,tokenDayCap:DEFAULT_TOKEN_DAY_CAP,tokenWeekCap:DEFAULT_TOKEN_WEEK_CAP,tradeSizeSol:.075,liveDailyCap:1,shadowDailyCaps:[2,3],minMarketCapUsd:null,newPositionOnly:true};
}
function ts(x:any){const raw=x?.buyTimestamp;if(typeof raw==="number"&&Number.isFinite(raw))return raw>1e12?Math.floor(raw/1000):raw;const asNum=Number(raw);if(Number.isFinite(asNum)&&asNum>0)return asNum>1e12?Math.floor(asNum/1000):asNum;const parsed=Date.parse(String(raw||""));return Number.isFinite(parsed)?Math.floor(parsed/1000):0;}
function isoWeekKey(sec:number){const d=new Date(sec*1000),u=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));const day=u.getUTCDay()||7;u.setUTCDate(u.getUTCDate()+4-day);const y0=new Date(Date.UTC(u.getUTCFullYear(),0,1));const week=Math.ceil((((u.getTime()-y0.getTime())/86400000)+1)/7);return `${u.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;}
function tripKey(x:any){return `${x?.mint||"?"}|${ts(x)}|${x?.buySignature||"?"}`;}
function dedupe(trips:any[]){const m=new Map<string,any>();for(const x of trips||[]){if(!x||n(x?.followerNetSol)==null||ts(x)<=0)continue;m.set(tripKey(x),x);}return [...m.values()].sort((a,b)=>ts(a)-ts(b));}
function simulate(trips:any[],dailyCap:number,policy:Policy){const dayCount=new Map<string,number>(),hourCount=new Map<string,number>(),tokenDay=new Map<string,number>(),tokenWeek=new Map<string,number>();const selected:any[]=[];let skippedDaily=0,skippedHourly=0,skippedTokenDay=0,skippedTokenWeek=0;
  for(const x of trips){const t=ts(x);if(!t)continue;const d=new Date(t*1000),day=d.toISOString().slice(0,10),hour=d.toISOString().slice(0,13),mint=String(x?.mint||"?"),week=isoWeekKey(t),td=`${mint}|${day}`,tw=`${mint}|${week}`;
    if((dayCount.get(day)||0)>=dailyCap){skippedDaily++;continue;}if((hourCount.get(hour)||0)>=policy.hourlyCap){skippedHourly++;continue;}if((tokenDay.get(td)||0)>=policy.tokenDayCap){skippedTokenDay++;continue;}if((tokenWeek.get(tw)||0)>=policy.tokenWeekCap){skippedTokenWeek++;continue;}
    selected.push(x);dayCount.set(day,(dayCount.get(day)||0)+1);hourCount.set(hour,(hourCount.get(hour)||0)+1);tokenDay.set(td,(tokenDay.get(td)||0)+1);tokenWeek.set(tw,(tokenWeek.get(tw)||0)+1);
  }
  const nets=selected.map(x=>n(x?.followerNetSol)).filter((x):x is number=>x!=null),s50=selected.map(x=>n(x?.stress50NetSol)).filter((x):x is number=>x!=null),s75=selected.map(x=>n(x?.stress75NetSol)).filter((x):x is number=>x!=null),wins=nets.filter(x=>x>0),grossWins=sum(wins),largest=wins.length?Math.max(...wins):0;
  return{dailyCap,selected:nets.length,netSol:sum(nets),stress50NetSol:sum(s50),stress75NetSol:sum(s75),winRate:nets.length?wins.length/nets.length:null,largestWinnerShare:grossWins>0?largest/grossWins:null,skipped:{daily:skippedDaily,hourly:skippedHourly,tokenDay:skippedTokenDay,tokenWeek:skippedTokenWeek}};
}
function marginal(a:any,b:any){return{extraTrades:b.selected-a.selected,extraNetSol:b.netSol-a.netSol,extraStress50NetSol:b.stress50NetSol-a.stress50NetSol,extraStress75NetSol:b.stress75NetSol-a.stress75NetSol};}
function recommend(address:string,policy:Policy,cap1:any,cap2:any,cap3:any){const live=policy.liveDailyCap===2?cap2:cap1,next=policy.liveDailyCap===2?cap3:cap2,m=marginal(live,next);const robust=m.extraTrades>=2&&m.extraNetSol>0&&m.extraStress50NetSol>0&&m.extraStress75NetSol>0;return{address,liveDailyCap:policy.liveDailyCap,shadowDailyCaps:policy.shadowDailyCaps,recommendation:"HOLD_LIVE_CAP",nextSlotHistoricalSupport:robust?"POSITIVE_BUT_PROSPECTIVE_REQUIRED":"NOT_ROBUSTLY_POSITIVE",marginalLiveToNext:m,reasons:[robust?"next_slot_positive_base_stress50_stress75_but_requires_prospective_validation":"next_slot_not_robustly_positive","never_auto_change_live_odin_settings"]};}
async function main(){const startedAt=new Date().toISOString(),cp=await read(CP_PATH,{results:{}}),all=Object.entries(cp?.results||{}).map(([address,r0])=>{const r=r0 as AnyObj,tr=dedupe(Array.isArray(r?.canonicalReplay?.roundTrips)?r.canonicalReplay.roundTrips:[]);return{address,r,tr,status:String(r?.canonicalOverlay?.status||"UNKNOWN")};}).filter(x=>x.tr.length>0);all.sort((a,b)=>Number(FOCUS.includes(b.address))-Number(FOCUS.includes(a.address))||b.tr.length-a.tr.length);const rows=all.slice(0,MAX_WALLETS).map(x=>{const policy=policyFor(x.address),one=simulate(x.tr,1,policy),two=simulate(x.tr,2,policy),three=simulate(x.tr,3,policy);return{address:x.address,focused:FOCUS.includes(x.address),canonicalStatus:x.status,canonicalTrades:x.tr.length,policy,cap1:one,cap2:two,cap3:three,recommendation:recommend(x.address,policy,one,two,three)};});const out={schemaVersion:2,event:"shark_scout_odin_cap_audit_complete",startedAt,finishedAt:new Date().toISOString(),walletsExamined:rows.length,focusWallets:FOCUS,rows,notes:["Counterfactual is chronological first-eligible opportunity selection using canonical round trips only.","Ian is evaluated against its actual 1/hour, 1/day live cap; 2/day and 3/day remain shadow-only.","6mz is evaluated against its actual 2/hour, 2/day live cap; slot #3 remains shadow-only.","It models daily/hourly/token-day/token-week caps but cannot recreate opportunities absent from canonical history or fully reapply signal-time market-cap filtering when that field is absent from canonical trips.","Recommendation never auto-changes Odin; prospective Paper Odin/live follower evidence remains required before any cap increase.","This module never changes Odin settings or capital."]};await atomic(OUT_PATH,out);console.log(JSON.stringify(out));}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_odin_cap_audit_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
