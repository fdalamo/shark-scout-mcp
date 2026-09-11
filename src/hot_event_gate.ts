import { promises as fs } from "node:fs";
import path from "node:path";
import { routedRpc, providerFabricEnabled } from "./provider_fabric.js";

type State={schemaVersion:1;updatedAt:string;lastForcedAt:string;signatures:Record<string,string|null>};
const STATE_PATH=process.env.HOT_EVENT_STATE_PATH||"/data/hot-event-state.json";
const DECISION_PATH=process.env.HOT_EVENT_DECISION_PATH||"/data/hot-event-decision.json";
const FORCE_HOURS=Math.max(1,Math.min(24,Number(process.env.HOT_EVENT_FORCE_REFRESH_HOURS||6)));
const TARGETS=(process.env.HOT_EVENT_WALLETS||[
  "ianCETBFexGgK8TA3gSLeAaNiLMsJPgUN1H44jhxQtB",
  "6mzEFZ458A6qcaQLgtBuYYaGJ1qN5tz2Wsr6PC1fLFzx",
  "5mcTKhm5iyb8Zz3jpxuNr7BT78i6AKy5RqoMGkFNj8ZZ"
].join(",")).split(",").map(x=>x.trim()).filter(Boolean);
const HOT_SIGNATURE_PROVIDER_ORDER=["solana_tracker","alchemy","chainstack","helius"] as const;
async function load():Promise<State>{try{const x=JSON.parse(await fs.readFile(STATE_PATH,"utf8"));return{schemaVersion:1,updatedAt:x.updatedAt||new Date(0).toISOString(),lastForcedAt:x.lastForcedAt||new Date(0).toISOString(),signatures:x.signatures||{}};}catch{return{schemaVersion:1,updatedAt:new Date(0).toISOString(),lastForcedAt:new Date(0).toISOString(),signatures:{}};}}
async function atomic(file:string,value:unknown){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(value));await fs.rename(tmp,file);}
async function latestSignature(wallet:string){const x=await routedRpc("getSignaturesForAddress",[wallet,{limit:1}],{preferred:[...HOT_SIGNATURE_PROVIDER_ORDER]});const rows=Array.isArray(x.result)?x.result as Array<{signature?:string}>:[];return rows[0]?.signature||null;}
async function main(){
  const startedAt=new Date().toISOString(),previous=await load(),current:Record<string,string|null>={},errors:string[]=[];
  let changed=false,observedSignatures=0,baselineSignatures=0,unavailableSignatures=0;
  const fabricEnabled=providerFabricEnabled();
  for(const wallet of TARGETS){
    const prior=previous.signatures[wallet]??null;
    try{
      const observed=fabricEnabled?await latestSignature(wallet):prior;
      current[wallet]=observed;
      if(observed){
        observedSignatures++;
        if(prior){if(observed!==prior)changed=true;}
        else baselineSignatures++;
      }else unavailableSignatures++;
    }catch(e){
      errors.push(`${wallet}:${String(e)}`);
      current[wallet]=prior;
      if(prior)observedSignatures++;else unavailableSignatures++;
    }
  }
  // A null/unknown signature is not evidence of a source-wallet change. The hourly MONITOR pass
  // has already run Paper/Dip once; FINALIZE repeats only for a proven signature change, the
  // deliberate periodic safety refresh, or an RPC error where fail-open is preferable.
  const forced=Date.now()-Date.parse(previous.lastForcedAt)>=FORCE_HOURS*3600_000;
  const refresh=changed||forced||errors.length>0;
  const next:State={schemaVersion:1,updatedAt:new Date().toISOString(),lastForcedAt:forced?new Date().toISOString():previous.lastForcedAt,signatures:{...previous.signatures,...current}};
  await atomic(STATE_PATH,next);
  const decision={schemaVersion:2,event:"shark_scout_hot_event_gate",startedAt,finishedAt:new Date().toISOString(),targets:TARGETS.length,fabricEnabled,providerOrder:HOT_SIGNATURE_PROVIDER_ORDER,changed,forced,refresh,observedSignatures,baselineSignatures,unavailableSignatures,errors,currentSignatures:current};
  await atomic(DECISION_PATH,decision);
  console.log(JSON.stringify({level:"info",...decision}));
}
main().catch(async e=>{const decision={schemaVersion:2,event:"shark_scout_hot_event_gate",finishedAt:new Date().toISOString(),targets:TARGETS.length,providerOrder:HOT_SIGNATURE_PROVIDER_ORDER,changed:false,forced:false,refresh:true,observedSignatures:0,baselineSignatures:0,unavailableSignatures:TARGETS.length,errors:[String(e)]};try{await atomic(DECISION_PATH,decision);}catch{}console.log(JSON.stringify({level:"warn",...decision}));process.exitCode=0;});