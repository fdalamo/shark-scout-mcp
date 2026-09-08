import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256, stableJson } from "./prospective_ab_lab.js";

const TRANSFER_PATH=process.env.SCOUT_ODIN_TRANSFER_REPORT_PATH||"/data/odin-transfer-report.json";
const STATE_PATH=process.env.SCOUT_ODIN_GOLDEN_FIXTURE_PATH||"/data/odin-golden-fixtures.json";
const OUT_PATH=process.env.SCOUT_ODIN_GOLDEN_FIXTURE_REPORT_PATH||"/data/odin-golden-fixture-report.json";
const NET_TOLERANCE=Math.max(1e-12,Number(process.env.ODIN_GOLDEN_NET_TOLERANCE_SOL||1e-8));
type AnyObj=Record<string,any>;

async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function now(){return new Date().toISOString();}
function normalized(x:AnyObj){return{wallet:String(x.wallet||""),opportunityId:String(x.opportunityId||""),mint:String(x.mint||""),copySignature:String(x.copySignature||""),sourceBuyTs:x.sourceBuyTs??null,followerBuyTs:x.followerBuyTs??null,sourceExitTs:x.sourceExitTs??null,followerExitTs:x.followerExitTs??null,buyLatencySec:x.buyLatencySec??null,exitLatencySec:x.exitLatencySec??null,perfectCopyNetSol:x.perfectCopyNetSol??null,actualNetSol:x.actualNetSol??null,closedFraction:x.closedFraction??null};}
function identity(x:AnyObj){return sha256(stableJson({wallet:x.wallet,opportunityId:x.opportunityId,mint:x.mint,copySignature:x.copySignature,sourceBuyTs:x.sourceBuyTs,followerBuyTs:x.followerBuyTs,sourceExitTs:x.sourceExitTs,followerExitTs:x.followerExitTs}));}

async function main(){
 const startedAt=now(),transfer=await read(TRANSFER_PATH,{}),state=await read(STATE_PATH,{schemaVersion:1,fixtures:{}});state.schemaVersion=1;state.fixtures||={};let added=0;const mismatches:any[]=[];
 const closed=(Array.isArray(transfer?.executionDiagnostics)?transfer.executionDiagnostics:[]).filter((x:AnyObj)=>x?.closed===true&&x?.opportunityId&&x?.copySignature&&Number.isFinite(Number(x?.actualNetSol)));
 for(const raw of closed){const x=normalized(raw),key=x.opportunityId,fp=identity(x),prior=state.fixtures[key];if(!prior){state.fixtures[key]={...x,identityHash:fp,frozenAt:now(),sourceTransferHash:transfer?.hash??null};added++;continue;}const idChanged=prior.identityHash!==fp,netChanged=Math.abs(Number(prior.actualNetSol)-Number(x.actualNetSol))>NET_TOLERANCE;if(idChanged||netChanged)mismatches.push({opportunityId:key,wallet:x.wallet,mint:x.mint,idChanged,netChanged,frozen:{identityHash:prior.identityHash,actualNetSol:prior.actualNetSol},current:{identityHash:fp,actualNetSol:x.actualNetSol}});}
 state.updatedAt=now();await atomic(STATE_PATH,state);const fixtures=Object.values(state.fixtures) as AnyObj[],sixMz=fixtures.filter(x=>String(x.wallet||"").startsWith("6mzEFZ458A")).sort((a,b)=>Number(b.actualNetSol||-999)-Number(a.actualNetSol||-999));
 const report={schemaVersion:1,event:"shark_scout_odin_golden_fixture_guard_complete",startedAt,finishedAt:now(),currentClosedMatches:closed.length,totalFrozenFixtures:fixtures.length,added,mismatchCount:mismatches.length,mismatches,sixMzReference:sixMz[0]??null,integrity:mismatches.length?"FAIL":"PASS",notes:["Each completed ACTUAL_ODIN opportunity is frozen by deterministic opportunity identity and exact matched follower copy signature.","Identity/timestamp drift or realized-net drift beyond tolerance is surfaced as a regression instead of silently rewriting the fixture.","6mz reference is selected only by the known 6mz wallet prefix and highest frozen realized net; token naming is not guessed."],guardrails:{advisoryOnly:true,odinMutation:false,fixtureMutation:"append-only except metadata timestamp"}};await atomic(OUT_PATH,report);console.log(JSON.stringify(report));if(mismatches.length)process.exitCode=2;
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_odin_golden_fixture_guard_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
