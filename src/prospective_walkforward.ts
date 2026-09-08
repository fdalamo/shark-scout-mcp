import { promises as fs } from "node:fs";
import path from "node:path";

const FUNNEL_PATH=process.env.SCOUT_EVIDENCE_FUNNEL_PATH||"/data/evidence-funnel.json";
const STATE_PATH=process.env.SCOUT_WALKFORWARD_STATE_PATH||"/data/prospective-walkforward.json";
const OUT_PATH=process.env.SCOUT_WALKFORWARD_REPORT_PATH||"/data/prospective-walkforward-report.json";
const TOP=Math.max(3,Math.min(20,Number(process.env.WALKFORWARD_TOP||8)));
const CONTROLS=Math.max(3,Math.min(20,Number(process.env.WALKFORWARD_CONTROLS||8)));

type AnyObj=Record<string,any>;
function now(){return new Date().toISOString();}
function day(){return new Date().toISOString().slice(0,10);}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function snap(x:any,role:"SELECTED"|"CONTROL"){
  return{address:String(x?.address||""),role,actionable:Boolean(x?.actionable),canonicalOverlayStatus:x?.canonicalOverlayStatus??null,nearPassScore:Number(x?.nearPassScore||0),medianHoldHours:x?.medianHoldHours??null,replay:{trades:x?.replay?.trades??null,net:x?.replay?.net??null,stress50:x?.replay?.stress50??null,source:x?.replay?.source??null,authoritative:Boolean(x?.replay?.authoritative)},sampleQuality:x?.sampleQuality??null,blockers:Array.isArray(x?.blockers)?x.blockers:[],evaluatedAt:x?.evaluatedAt??null};
}
function currentMap(funnel:any){const all=[...(Array.isArray(funnel?.topActionable)?funnel.topActionable:[]),...(Array.isArray(funnel?.topNearPasses)?funnel.topNearPasses:[]),...(Array.isArray(funnel?.topReplayBlocks)?funnel.topReplayBlocks:[]),...(Array.isArray(funnel?.topSampleQualityBlocks)?funnel.topSampleQualityBlocks:[])];return new Map(all.map((x:any)=>[String(x?.address||""),x]));}
async function main(){
  const startedAt=now(),[funnel,state0]=await Promise.all([read(FUNNEL_PATH,{}),read(STATE_PATH,{schemaVersion:1,cohorts:[]})]);
  const state=state0;state.schemaVersion=1;state.cohorts=Array.isArray(state.cohorts)?state.cohorts:[];
  const cohortId=day();let cohort=state.cohorts.find((x:any)=>x?.cohortId===cohortId);
  let frozen=false;
  if(!cohort){
    const selected=(Array.isArray(funnel?.topActionable)?funnel.topActionable:[]).slice(0,TOP).map((x:any)=>snap(x,"SELECTED"));
    const controls=(Array.isArray(funnel?.topNearPasses)?funnel.topNearPasses:[]).slice(0,CONTROLS).map((x:any)=>snap(x,"CONTROL"));
    cohort={cohortId,frozenAt:now(),funnelFinishedAt:funnel?.finishedAt||null,members:[...selected,...controls]};state.cohorts.push(cohort);frozen=true;
  }
  const cmap=currentMap(funnel);
  for(const c of state.cohorts){
    c.observedAt=now();
    c.observations=(Array.isArray(c.members)?c.members:[]).map((m:any)=>{const cur=cmap.get(String(m.address)) as AnyObj|undefined;const bt=Number(m?.replay?.trades),bn=Number(m?.replay?.net),bs=Number(m?.replay?.stress50),ct=Number(cur?.replay?.trades),cn=Number(cur?.replay?.net),cs=Number(cur?.replay?.stress50);return{address:m.address,role:m.role,currentFound:Boolean(cur),currentActionable:cur?Boolean(cur.actionable):null,currentBlockers:cur?.blockers??null,currentReplay:cur?.replay??null,deltaTrades:Number.isFinite(bt)&&Number.isFinite(ct)?ct-bt:null,deltaNet:Number.isFinite(bn)&&Number.isFinite(cn)?cn-bn:null,deltaStress50:Number.isFinite(bs)&&Number.isFinite(cs)?cs-bs:null};});
  }
  if(state.cohorts.length>120)state.cohorts=state.cohorts.slice(-120);state.updatedAt=now();await atomic(STATE_PATH,state);
  const report={schemaVersion:1,event:"shark_scout_prospective_walkforward_complete",startedAt,finishedAt:now(),cohortId,frozen,newCohortMembers:Array.isArray(cohort?.members)?cohort.members.length:0,cohortCount:state.cohorts.length,latestCohort:cohort,
    notes:["Each UTC-day cohort freezes the first observed actionable candidates and near-pass controls; later runs update outcomes but never rewrite the frozen feature snapshot.","This module consumes existing evidence-funnel output only and adds zero provider/API calls.","Delta replay fields are observational until enough genuinely post-freeze trades accumulate; they are not promotion gates yet."]};
  await atomic(OUT_PATH,report);console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_prospective_walkforward_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
