import { promises as fs } from "node:fs";
import path from "node:path";

export type GovernedProvider="chainstack"|"solana_tracker"|"alchemy"|"helius";
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
export async function allocateProviders(method:string,candidates:GovernedProvider[],lifetimeRequests:Partial<Record<GovernedProvider,number>>={}):Promise<GovernedProvider[]>{const snap=await providerBudgetSnapshot();return [...candidates].sort((a,b)=>{const ta=specialtyTier(a,method),tb=specialtyTier(b,method);if(ta!==tb)return ta-tb;const pa=(snap.providers as any)[a]?.pressure||0,pb=(snap.providers as any)[b]?.pressure||0;if(pa!==pb)return pa-pb;return (lifetimeRequests[a]||0)-(lifetimeRequests[b]||0);});}
export async function providerAllowed(provider:GovernedProvider,estimatedUnits:number){const snap=await providerBudgetSnapshot();const x=(snap.providers as any)[provider] as {units:number;softUnits:number|null}|undefined;if(!x?.softUnits)return true;return x.units+Math.max(0,estimatedUnits)<=x.softUnits;}
