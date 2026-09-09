import { promises as fs } from "node:fs";
import path from "node:path";

export type GovernedProvider="chainstack"|"solana_tracker"|"alchemy"|"helius";
export type WorkClass="HOT"|"COLD"|"SYSTEM";
export type ProviderAdaptiveHealth={requests:number;successes:number;failures:number;rateLimited:number;latencyMsTotal:number;estimatedUnits:number};
type Usage={requests:number;units:number;byClass?:Partial<Record<WorkClass,number>>};
type BudgetState={schemaVersion:2;month:string;updatedAt:string;providers:Record<string,Usage>};

const STATE_PATH=process.env.PROVIDER_BUDGET_STATE_PATH||"/data/provider-budget-state.json";
const MONTHLY_SOFT:Record<GovernedProvider,number>={
  chainstack:Number(process.env.CHAINSTACK_MONTHLY_SOFT_UNITS||2400000),
  solana_tracker:Number(process.env.SOLANA_TRACKER_MONTHLY_SOFT_UNITS||400000),
  alchemy:Number(process.env.ALCHEMY_MONTHLY_SOFT_UNITS||24000000),
  helius:Number(process.env.HELIUS_GENERIC_MONTHLY_SOFT_UNITS||800000)
};
const LEGACY_DAILY:Partial<Record<GovernedProvider,number>>={
  chainstack:Number(process.env.CHAINSTACK_DAILY_SOFT_UNITS||0),
  solana_tracker:Number(process.env.SOLANA_TRACKER_DAILY_SOFT_UNITS||0),
  alchemy:Number(process.env.ALCHEMY_DAILY_SOFT_UNITS||0),
  helius:Number(process.env.HELIUS_GENERIC_DAILY_SOFT_UNITS||0)
};
const TARGET=Math.max(.50,Math.min(.95,Number(process.env.PROVIDER_MONTHLY_TARGET_FRACTION||.82)));
const BURST_FRACTION=Math.max(.01,Math.min(.20,Number(process.env.PROVIDER_PACING_BURST_FRACTION||.05)));
let writeQueue=Promise.resolve();

function month(){return new Date().toISOString().slice(0,7);}
function blank():BudgetState{return{schemaVersion:2,month:month(),updatedAt:new Date().toISOString(),providers:{}};}
function daysInUtcMonth(d=new Date()){return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();}
function elapsedFraction(){const d=new Date(),days=daysInUtcMonth(d);return Math.max(1/days,Math.min(1,((d.getUTCDate()-1)+(d.getUTCHours()+d.getUTCMinutes()/60)/24)/days));}
function currentWorkClass():WorkClass{return process.env.SCOUT_WORK_CLASS==="HOT"||process.env.SCOUT_WORK_CLASS==="SYSTEM"?process.env.SCOUT_WORK_CLASS:"COLD";}
async function read():Promise<BudgetState>{try{const x=JSON.parse(await fs.readFile(STATE_PATH,"utf8"));if(x?.schemaVersion!==2||x?.month!==month())return blank();return{schemaVersion:2,month:x.month,updatedAt:x.updatedAt||new Date().toISOString(),providers:x.providers||{}};}catch{return blank();}}
async function write(s:BudgetState){await fs.mkdir(path.dirname(STATE_PATH),{recursive:true});s.updatedAt=new Date().toISOString();const tmp=`${STATE_PATH}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(s));await fs.rename(tmp,STATE_PATH);}
function monthlySoft(provider:GovernedProvider){const x=MONTHLY_SOFT[provider];return Number.isFinite(x)&&x>0?x:null;}
function legacyDailySoft(provider:GovernedProvider){const x=LEGACY_DAILY[provider];return typeof x==="number"&&Number.isFinite(x)&&x>0?x:null;}
function ceilings(provider:GovernedProvider,workClass:WorkClass){const soft=monthlySoft(provider);if(!soft)return{soft:null,target:null,pace:null,hard:null};const target=soft*TARGET,elapsed=elapsedFraction(),burst=soft*BURST_FRACTION;const classExtra=workClass==="COLD"?0:workClass==="HOT"?soft*.10:soft*.15;const pace=Math.min(soft,target*elapsed+burst+classExtra);const hard=workClass==="COLD"?target:workClass==="HOT"?soft*.95:soft;return{soft,target,pace,hard};}

export async function recordProviderBurn(provider:GovernedProvider,units:number,workClass:WorkClass=currentWorkClass()){
  writeQueue=writeQueue.then(async()=>{const s=await read();const u=s.providers[provider]||{requests:0,units:0,byClass:{}};u.requests++;u.units+=Math.max(0,units);u.byClass=u.byClass||{};u.byClass[workClass]=(u.byClass[workClass]||0)+Math.max(0,units);s.providers[provider]=u;await write(s);}).catch(()=>{});await writeQueue;
}

export async function providerBudgetSnapshot(){
  const s=await read();const workClass=currentWorkClass();
  return{month:s.month,targetFraction:TARGET,elapsedFraction:elapsedFraction(),workClass,providers:Object.fromEntries((Object.keys(MONTHLY_SOFT) as GovernedProvider[]).map(p=>{const u=s.providers[p]||{requests:0,units:0,byClass:{}};const c=ceilings(p,workClass),legacy=legacyDailySoft(p);return[p,{...u,monthlySoftUnits:c.soft,targetUnits:c.target,paceCeilingUnits:c.pace,hardCeilingUnits:c.hard,pressure:c.soft?u.units/c.soft:0,targetPressure:c.target?u.units/c.target:0,remainingUnits:c.hard?Math.max(0,c.hard-u.units):null,legacyDailySoftUnits:legacy}];}))};
}

const TRACKER_SPECIAL=new Set(["getProgramAccountsV2","getTokenAccountsByOwnerV2"]);
const HISTORICAL=new Set(["getTransaction","getSignaturesForAddress","getProgramAccounts","getBlock","getBlocks","getBlockTime","getSignaturesForAddressWithConfig"]);
function specialtyTier(provider:GovernedProvider,method:string){if(TRACKER_SPECIAL.has(method)){if(provider==="solana_tracker")return 0;if(provider==="chainstack"||provider==="alchemy")return 1;return 3;}if(HISTORICAL.has(method)){if(provider==="chainstack"||provider==="alchemy")return 0;if(provider==="solana_tracker")return 2;return 3;}if(provider==="chainstack"||provider==="alchemy")return 0;if(provider==="solana_tracker")return 1;return 3;}
function normalizedHealth(h:ProviderAdaptiveHealth|undefined){const requests=Math.max(0,h?.requests||0),successes=Math.max(0,h?.successes||0),failures=Math.max(0,h?.failures||0),rateLimited=Math.max(0,h?.rateLimited||0);const avgLatencyMs=successes>0?(h?.latencyMsTotal||0)/successes:750;const successRate=requests>0?successes/requests:.995;const failureRate=requests>0?failures/requests:0;const rateLimitRate=requests>0?rateLimited/requests:0;return{avgLatencyMs,successRate,failureRate,rateLimitRate};}
function adaptiveScore(provider:GovernedProvider,method:string,workClass:WorkClass,pressure:number,h:ProviderAdaptiveHealth|undefined,lifetimeRequests:number){const tier=specialtyTier(provider,method),m=normalizedHealth(h);const latencyPenalty=Math.min(6,m.avgLatencyMs/250);const reliabilityPenalty=(1-m.successRate)*24+m.failureRate*10+m.rateLimitRate*30;const pressurePenalty=Math.max(0,pressure)*(workClass==="COLD"?18:workClass==="HOT"?5:9);const loadPenalty=Math.log10(1+Math.max(0,lifetimeRequests))/8;const reservePenalty=provider==="helius"?(workClass==="HOT"?5:14):0;const weights=workClass==="HOT"?{tier:7,latency:2,reliability:3.5}:{tier:10,latency:.8,reliability:2};return tier*weights.tier+latencyPenalty*weights.latency+reliabilityPenalty*weights.reliability+pressurePenalty+loadPenalty+reservePenalty;}

export async function allocateProviders(method:string,candidates:GovernedProvider[],lifetimeRequests:Partial<Record<GovernedProvider,number>>={},adaptiveHealth:Partial<Record<GovernedProvider,ProviderAdaptiveHealth>>={},workClass:WorkClass=currentWorkClass()):Promise<GovernedProvider[]>{const snap=await providerBudgetSnapshot();return [...candidates].sort((a,b)=>{const pa=(snap.providers as any)[a]?.targetPressure||0,pb=(snap.providers as any)[b]?.targetPressure||0;const sa=adaptiveScore(a,method,workClass,pa,adaptiveHealth[a],lifetimeRequests[a]||0),sb=adaptiveScore(b,method,workClass,pb,adaptiveHealth[b],lifetimeRequests[b]||0);if(sa!==sb)return sa-sb;const ta=specialtyTier(a,method),tb=specialtyTier(b,method);if(ta!==tb)return ta-tb;return(lifetimeRequests[a]||0)-(lifetimeRequests[b]||0);});}

export async function providerAllowed(provider:GovernedProvider,estimatedUnits:number,workClass:WorkClass=currentWorkClass()){
  const s=await read(),u=s.providers[provider]||{requests:0,units:0};const c=ceilings(provider,workClass),need=Math.max(0,estimatedUnits);const legacy=legacyDailySoft(provider);
  if(legacy&&need>legacy)return false;
  if(!c.soft)return true;
  const next=u.units+need;
  return next<=Math.min(c.pace??Infinity,c.hard??Infinity);
}
