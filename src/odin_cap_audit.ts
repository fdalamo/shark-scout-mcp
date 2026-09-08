import { promises as fs } from "node:fs";
import path from "node:path";
import { researchFocusWallets, walletPolicy } from "./wallet_policy.js";

const CP_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"./data/gauntlet-state.json";
const OUT_PATH=process.env.SCOUT_ODIN_CAP_AUDIT_PATH||"./data/odin-cap-audit.json";
const FOCUS=(process.env.ODIN_CAP_AUDIT_FOCUS||researchFocusWallets().join(",")).split(",").map(x=>x.trim()).filter(Boolean);
const MAX_WALLETS=Math.max(5,Math.min(100,Number(process.env.ODIN_CAP_AUDIT_MAX_WALLETS||40)));

type AnyObj=Record<string,any>;
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function ts(x:any){const raw=x?.buyTimestamp;if(typeof raw==="number"&&Number.isFinite(raw))return raw>1e12?Math.floor(raw/1000):raw;const asNum=Number(raw);if(Number.isFinite(asNum)&&asNum>0)return asNum>1e12?Math.floor(asNum/1000):asNum;const parsed=Date.parse(String(raw||""));return Number.isFinite(parsed)?Math.floor(parsed/1000):0;}
function isoWeekKey(sec:number){const d=new Date(sec*1000),u=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));const day=u.getUTCDay()||7;u.setUTCDate(u.getUTCDate()+4-day);const y0=new Date(Date.UTC(u.getUTCFullYear(),0,1));const week=Math.ceil((((u.getTime()-y0.getTime())/86400000)+1)/7);return `${u.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;}
function tripKey(x:any){return `${x?.mint||"?"}|${ts(x)}|${x?.buySignature||"?"}`;}
function dedupe(trips:any[]){const m=new Map<string,any>();for(const x of trips||[]){if(!x||n(x?.followerNetSol)==null||ts(x)<=0)continue;m.set(tripKey(x),x);}return [...m.values()].sort((a,b)=>ts(a)-ts(b));}
function simulate(trips:any[],dailyCap:number,address:string){const policy=walletPolicy(address),dayCount=new Map<string,number>(),hourCount=new Map<string,number>(),tokenDay=new Map<string,number>(),tokenWeek=new Map<string,number>();const selected:any[]=[];let skippedDaily=0,skippedHourly=0,skippedTokenDay=0,skippedTokenWeek=0;
  for(const x of trips){const t=ts(x);if(!t)continue;const d=new Date(t*1000),day=d.toISOString().slice(0,10),hour=d.toISOString().slice(0,13),mint=String(x?.mint||"?"),week=isoWeekKey(t),td=`${mint}|${day}`,tw=`${mint}|${week}`;
    if((dayCount.get(day)||0)>=dailyCap){skippedDaily++;continue;}if((hourCount.get(hour)||0)>=policy.hourlyCap){skippedHourly++;continue;}if((tokenDay.get(td)||0)>=policy.tokenDayCap){skippedTokenDay++;continue;}if((tokenWeek.get(tw)||0)>=policy.tokenWeekCap){skippedTokenWeek++;continue;}
    selected.push(x);dayCount.set(day,(dayCount.get(day)||0)+1);hourCount.set(hour,(hourCount.get(hour)||0)+1);tokenDay.set(td,(tokenDay.get(td)||0)+1);tokenWeek.set(tw,(tokenWeek.get(tw)||0)+1);
  }
  const nets=selected.map(x=>n(x?.followerNetSol)).filter((x):x is number=>x!=null),s50=selected.map(x=>n(x?.stress50NetSol)).filter((x):x is number=>x!=null),s75=selected.map(x=>n(x?.stress75NetSol)).filter((x):x is number=>x!=null),wins=nets.filter(x=>x>0),grossWins=sum(wins),largest=wins.length?Math.max(...wins):0;
  return{dailyCap,selected:nets.length,netSol:sum(nets),stress50NetSol:sum(s50),stress75NetSol:sum(s75),winRate:nets.length?wins.length/nets.length:null,largestWinnerShare:grossWins>0?largest/grossWins:null,skipped:{daily:skippedDaily,hourly:skippedHourly,tokenDay:skippedTokenDay,tokenWeek:skippedTokenWeek}};
}
function marginal(a:any,b:any){return{extraTrades:b.selected-a.selected,extraNetSol:b.netSol-a.netSol,extraStress50NetSol:b.stress50NetSol-a.stress50NetSol,extraStress75NetSol:b.stress75NetSol-a.stress75NetSol};}
function recommend(address:string,cap1:any,cap2:any,cap3:any){const policy=walletPolicy(address),live=policy.dailyCap===2?cap2:cap1,next=policy.dailyCap===2?cap3:cap2,m=marginal(live,next);const robust=m.extraTrades>=2&&m.extraNetSol>0&&m.extraStress50NetSol>0&&m.extraStress75NetSol>0;return{address,liveDailyCap:policy.dailyCap,shadowDailyCaps:policy.shadowDailyCaps,recommendation:"HOLD_LIVE_CAP",nextSlotHistoricalSupport:robust?"POSITIVE_BUT_PROSPECTIVE_REQUIRED":"NOT_ROBUSTLY_POSITIVE",marginalLiveToNext:m,reasons:[robust?"next_slot_positive_base_stress50_stress75_but_requires_prospective_validation":"next_slot_not_robustly_positive","never_auto_change_live_odin_settings"]};}
function diagnosticReason(r:any){const replay=r?.canonicalReplay;const raw=Array.isArray(replay?.roundTrips)?replay.roundTrips:[];if(!raw.length)return "NO_CANONICAL_TRIPS";const valid=dedupe(raw);if(!valid.length)return "NO_USABLE_CANONICAL_TRIPS";return "NOT_SELECTED_WITHIN_AUDIT_LIMIT";}
async function main(){
  const startedAt=new Date().toISOString(),cp=await read(CP_PATH,{results:{}}),resultEntries=Object.entries(cp?.results||{});
  const all=resultEntries.map(([address,r0])=>{const r=r0 as AnyObj,tr=dedupe(Array.isArray(r?.canonicalReplay?.roundTrips)?r.canonicalReplay.roundTrips:[]);return{address,r,tr,status:String(r?.canonicalOverlay?.status||"UNKNOWN")};}).filter(x=>x.tr.length>0);
  all.sort((a,b)=>Number(FOCUS.includes(b.address))-Number(FOCUS.includes(a.address))||b.tr.length-a.tr.length);
  const rows:any[]=all.slice(0,MAX_WALLETS).map(x=>{const policy=walletPolicy(x.address),one=simulate(x.tr,1,x.address),two=simulate(x.tr,2,x.address),three=simulate(x.tr,3,x.address);return{address:x.address,focused:FOCUS.includes(x.address),canonicalStatus:x.status,canonicalTrades:x.tr.length,evidenceStatus:"AVAILABLE",diagnostic:null,policy,cap1:one,cap2:two,cap3:three,recommendation:recommend(x.address,one,two,three)};});
  const emitted=new Set(rows.map(x=>x.address));
  const byAddress=new Map(resultEntries.map(([address,r0])=>[address,r0 as AnyObj]));
  for(const address of FOCUS){if(emitted.has(address))continue;const r=byAddress.get(address);rows.push({address,focused:true,canonicalStatus:String(r?.canonicalOverlay?.status||"UNKNOWN"),canonicalTrades:0,evidenceStatus:"UNAVAILABLE",diagnostic:diagnosticReason(r),policy:walletPolicy(address),cap1:null,cap2:null,cap3:null,recommendation:{address,liveDailyCap:walletPolicy(address).dailyCap,shadowDailyCaps:walletPolicy(address).shadowDailyCaps,recommendation:"HOLD_LIVE_CAP",nextSlotHistoricalSupport:"UNKNOWN",marginalLiveToNext:null,reasons:[diagnosticReason(r),"missing_canonical_cap_evidence_is_unknown_not_zero","never_auto_change_live_odin_settings"]}});}
  const focusDiagnostics=rows.filter(x=>x.focused).map(x=>({address:x.address,evidenceStatus:x.evidenceStatus,diagnostic:x.diagnostic,canonicalTrades:x.canonicalTrades}));
  const out={schemaVersion:4,event:"shark_scout_odin_cap_audit_complete",startedAt,finishedAt:new Date().toISOString(),focusWallets:FOCUS,focusDiagnostics,walletsExamined:rows.length,rows,notes:["Counterfactual is chronological first-eligible opportunity selection using canonical round trips only.","Every configured focus wallet now emits a row; absent canonical evidence is explicitly UNKNOWN/UNAVAILABLE rather than silently omitted or treated as zero.","Wallet hourly/daily/token caps are sourced from the same shared policy registry used by Paper Odin and Dip Shadow.","Ian remains live 1/day with 2/day and 3/day shadow-only; 6mz remains live 2/day with slot #3 shadow-only.","The audit cannot recreate opportunities absent from canonical history or fully reapply signal-time MC/liquidity filters when canonical rows lack those fields.","Recommendation never auto-changes Odin; prospective Paper Odin/live follower evidence remains required before any cap increase."]};
  await atomic(OUT_PATH,out);console.log(JSON.stringify(out));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_odin_cap_audit_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});