import { promises as fs } from "node:fs";
import path from "node:path";

export type GovernedProvider="chainstack"|"solana_tracker"|"alchemy"|"helius";
export type WorkClass="HOT"|"COLD"|"SYSTEM";
export type ProviderAdaptiveHealth={requests:number;successes:number;failures:number;rateLimited:number;latencyMsTotal:number;estimatedUnits:number};
type Usage={requests:number;units:number};
type BudgetState={schemaVersion:1;day:string;updatedAt:string;providers:Record<string,Usage>};
const STATE_PATH=process.env.PROVIDER_BUDGET_STATE_PATH||"/data/provider-budget-state.json";
const SOFT:Record<GovernedProvider,number>={
  chainstack:Number(process.env.CHAINSTACK_DAILY_SOFT_UNITS||0),
  solana_tracker:Number(process.env.SOLANA_TRACKER_DAILY_SOFT_UNITS||12000),
  alchemy:Number(process.env.ALCHEMY_DAILY_SOFT_UNITS||0),
  // Generic RPC only. Helius specialty/enriched APIs are intentionally outside this budget.
  helius:Number(process.env.HELIUS_GENERIC_DAILY_SOFT_UNITS||1500)
};
let writeQueue=Promise.resolve();
function day(){return new Date().toISOString().slice(0,10);}
function blank():BudgetState{return{schemaVersion:1,day:day(),updatedAt:new Date().toISOString(),providers:{}};}
async function read():Promise<BudgetState>{try{const x=JSON.parse(await fs.readFile(STATE_PATH,"utf8"));if(x?.day!==day())return blank();return{schemaVersion:1,day:x.day,updatedAt:x.updatedAt||new Date().toISOString(),providers:x.providers||{}};}catch{return blank();}}
async function write(s:BudgetState){await fs.mkdir(path.dirname(STATE_PATH),{recursive:true});s.updatedAt=new Date().toISOString();const tmp=`${STATE_PATH}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(s));await fs.rename(tmp,STATE_PATH);}
export async function recordProviderBurn(provider:GovernedProvider,units:number){writeQueue=writeQueue.then(async()=>{const s=await read();const u=s.providers[provider]||{requests:0,units:0};u.requests++;u.units+=Math.max(0,units);s.providers[provider]=u;await write(s);}).catch(()=>{});await writeQueue;}
export async function providerBudgetSnapshot(){const s=await read();return{day:s.day,providers:Object.fromEntries((Object.keys(SOFT) as GovernedProvider[]).map(p=>{const u=s.providers[p]||{requests:0,units:0};const soft=Number.isFinite(SOFT[p])&&SOFT[p]>0?SOFT[p]:null;return[p,{...u,softUnits:soft,pressure:soft?u.units/soft:0,remainingUnits:soft?Math.max(0,soft-u.units):null}];}))};}
const TRACKER_SPECIAL=new Set(["getProgramAccountsV2","getTokenAccountsByOwnerV2"]);
const HISTORICAL=new Set(["getTransaction","getSignaturesForAddress","getProgramAccounts","getBlock","getBlocks","getBlockTime","getSignaturesForAddressWithConfig"]);
function specialtyTier(provider:GovernedProvider,method:string){if(TRACKER_SPECIAL.has(method)){if(provider==="solana_tracker")return 0;if(provider==="chainstack"||provider==="alchemy")return 1;return 3;}if(HISTORICAL.has(method)){if(provider==="chainstack"||provider==="alchemy")return 0;if(provider==="solana_tracker")return 2;return 3;}if(provider==="chainstack"||provider==="alchemy")return 0;if(provider==="solana_tracker")return 1;return 3;}
function normalizedHealth(h:ProviderAdaptiveHealth|undefined){const requests=Math.max(0,h?.requests||0),successes=Math.max(0,h?.successes||0),failures=Math.max(0,h?.failures||0),rateLimited=Math.max(0,h?.rateLimited||0);const avgLatencyMs=successes>0?(h?.latencyMsTotal||0)/successes:750;const successRate=requests>0?successes/requests:0.995;const failureRate=requests>0?failures/requests:0;const rateLimitRate=requests>0?rateLimited/requests:0;return{avgLatencyMs,successRate,failureRate,rateLimitRate};}
function adaptiveScore(provider:GovernedProvider,method:string,workClass:WorkClass,pressure:number,h:ProviderAdaptiveHealth|undefined,lifetimeRequests:number){const tier=specialtyTier(provider,method),m=normalizedHealth(h);const latencyPenalty=Math.min(6,m.avgLatencyMs/250);const reliabilityPenalty=(1-m.successRate)*24+m.failureRate*10+m.rateLimitRate*30;const pressurePenalty=Math.max(0,pressure)*(workClass==="COLD"?12:workClass==="HOT"?3:7);const loadPenalty=Math.log10(1+Math.max(0,lifetimeRequests))/8;const reservePenalty=provider==="helius"?(workClass==="HOT"?4:12):0;const weights=workClass==="HOT"?{tier:7,latency:2.0,reliability:3.5}:{tier:10,latency:0.8,reliability:2.0};return tier*weights.tier+latencyPenalty*weights.latency+reliabilityPenalty*weights.reliability+pressurePenalty+loadPenalty+reservePenalty;}
export async function allocateProviders(method:string,candidates:GovernedProvider[],lifetimeRequests:Partial<Record<GovernedProvider,number>>={},adaptiveHealth:Partial<Record<GovernedProvider,ProviderAdaptiveHealth>>={},workClass:WorkClass="COLD"):Promise<GovernedProvider[]>{const snap=await providerBudgetSnapshot();return [...candidates].sort((a,b)=>{const pa=(snap.providers as any)[a]?.pressure||0,pb=(snap.providers as any)[b]?.pressure||0;const sa=adaptiveScore(a,method,workClass,pa,adaptiveHealth[a],lifetimeRequests[a]||0),sb=adaptiveScore(b,method,workClass,pb,adaptiveHealth[b],lifetimeRequests[b]||0);if(sa!==sb)return sa-sb;const ta=specialtyTier(a,method),tb=specialtyTier(b,method);if(ta!==tb)return ta-tb;return (lifetimeRequests[a]||0)-(lifetimeRequests[b]||0);});}
export async function providerAllowed(provider:GovernedProvider,estimatedUnits:number){const snap=await providerBudgetSnapshot();const x=(snap.providers as any)[provider] as {units:number;softUnits:number|null}|undefined;if(!x?.softUnits)return true;return x.units+Math.max(0,estimatedUnits)<=x.softUnits;}
