import { promises as fs } from "node:fs";
import path from "node:path";
import { allocateProviders, providerAllowed, providerBudgetSnapshot, recordProviderBurn, type GovernedProvider } from "./provider_resource_governor.js";

type ProviderName = GovernedProvider;
type MethodHealth={requests:number;successes:number;failures:number;estimatedUnits:number};
type Health={requests:number;successes:number;failures:number;rateLimited:number;latencyMsTotal:number;estimatedUnits:number;byMethod:Record<string,MethodHealth>;lastError?:string;lastUsedAt?:string};
type State={schemaVersion:2;updatedAt:string;providers:Record<string,Health>};
type ProviderError=Error&{status?:number;retryAfterMs?:number};

const ENABLED=/^(1|true|yes)$/i.test(process.env.PROVIDER_FABRIC_ENABLED||"false");
const STATE_PATH=process.env.PROVIDER_FABRIC_STATE_PATH||"/data/provider-fabric-state.json";
const TIMEOUT_MS=Math.max(3000,Math.min(60000,Number(process.env.PROVIDER_FABRIC_TIMEOUT_MS||25000)));
const RATE_LIMIT_COOLDOWN_MS=Math.max(1000,Math.min(300000,Number(process.env.PROVIDER_FABRIC_RATE_LIMIT_COOLDOWN_MS||15000)));
const TRANSIENT_COOLDOWN_MS=Math.max(250,Math.min(60000,Number(process.env.PROVIDER_FABRIC_TRANSIENT_COOLDOWN_MS||3000)));
const URLS:Record<ProviderName,string|undefined>={
  chainstack:process.env.CHAINSTACK_SOLANA_RPC_URL?.trim(),
  solana_tracker:process.env.SOLANA_TRACKER_RPC_URL?.trim()||(process.env.SOLANA_TRACKER_API_KEY?.trim()?`https://rpc-mainnet.solanatracker.io/?api_key=${process.env.SOLANA_TRACKER_API_KEY.trim()}`:undefined),
  alchemy:process.env.ALCHEMY_SOLANA_RPC_URL?.trim(),
  helius:process.env.SOLANA_RPC_URL?.trim()||(process.env.HELIUS_API_KEY?.trim()?`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY.trim()}`:undefined)
};
const BASE_ORDER:ProviderName[]=String(process.env.PROVIDER_FABRIC_RPC_ORDER||"chainstack,solana_tracker,alchemy,helius").split(",").map(x=>x.trim()).filter((x):x is ProviderName=>x in URLS);
const MIN_INTERVAL:Record<ProviderName,number>={
  chainstack:Number(process.env.CHAINSTACK_MIN_INTERVAL_MS||50),
  // Published free ceiling is 5 RPS; ~4 RPS leaves headroom for jitter/retries.
  solana_tracker:Number(process.env.SOLANA_TRACKER_MIN_INTERVAL_MS||250),
  alchemy:Number(process.env.ALCHEMY_MIN_INTERVAL_MS||150),
  helius:Number(process.env.PROVIDER_FABRIC_HELIUS_MIN_INTERVAL_MS||120)
};
const TRACKER_EFFICIENT=new Set(["getProgramAccountsV2","getTokenAccountsByOwnerV2"]);
const HISTORICAL_HEAVY=new Set(["getTransaction","getSignaturesForAddress","getProgramAccounts","getBlock","getBlocks","getBlockTime","getSignaturesForAddressWithConfig"]);
const TRACKER_TEN_CREDIT=new Set(["getTransaction","getSignaturesForAddress","getProgramAccounts","getBlock","getBlocks"]);
const nextAt:Partial<Record<ProviderName,number>>={};
const cooldownUntil:Partial<Record<ProviderName,number>>={};
let rpcId=1;
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
function retryAfterMs(value:string|null){if(!value)return undefined;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds*1000);const at=Date.parse(value);return Number.isFinite(at)?Math.max(0,at-Date.now()):undefined;}
function cool(p:ProviderName,ms:number){cooldownUntil[p]=Math.max(cooldownUntil[p]||0,Date.now()+ms);}
function isCooling(p:ProviderName){return(cooldownUntil[p]||0)>Date.now();}
function blankHealth():Health{return{requests:0,successes:0,failures:0,rateLimited:0,latencyMsTotal:0,estimatedUnits:0,byMethod:{}};}
function normalizeHealth(v:any):Health{return{requests:Number(v?.requests||0),successes:Number(v?.successes||0),failures:Number(v?.failures||0),rateLimited:Number(v?.rateLimited||0),latencyMsTotal:Number(v?.latencyMsTotal||0),estimatedUnits:Number(v?.estimatedUnits||0),byMethod:v?.byMethod&&typeof v.byMethod==="object"?v.byMethod:{},lastError:v?.lastError,lastUsedAt:v?.lastUsedAt};}
async function readState():Promise<State>{try{const raw=JSON.parse(await fs.readFile(STATE_PATH,"utf8"));const providers:Record<string,Health>={};for(const[k,v]of Object.entries(raw?.providers||{}))providers[k]=normalizeHealth(v);return{schemaVersion:2,updatedAt:raw?.updatedAt||new Date().toISOString(),providers};}catch{return{schemaVersion:2,updatedAt:new Date().toISOString(),providers:{}};}}
async function saveState(s:State){await fs.mkdir(path.dirname(STATE_PATH),{recursive:true});s.updatedAt=new Date().toISOString();const tmp=`${STATE_PATH}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(s));await fs.rename(tmp,STATE_PATH);}
function health(s:State,p:ProviderName){return s.providers[p]||=(blankHealth());}
function methodHealth(h:Health,method:string){return h.byMethod[method]||={requests:0,successes:0,failures:0,estimatedUnits:0};}
function estimatedUnits(p:ProviderName,method:string){if(p==="solana_tracker")return TRACKER_TEN_CREDIT.has(method)?10:1;return 1;}
function recordAttempt(h:Health,p:ProviderName,method:string){const units=estimatedUnits(p,method);h.requests++;h.estimatedUnits+=units;const mh=methodHealth(h,method);mh.requests++;mh.estimatedUnits+=units;h.lastUsedAt=new Date().toISOString();}
function recordSuccess(h:Health,method:string,latencyMs:number){h.successes++;h.latencyMsTotal+=latencyMs;methodHealth(h,method).successes++;}
function recordFailure(h:Health,method:string,is429:boolean){h.failures++;if(is429)h.rateLimited++;methodHealth(h,method).failures++;}
function uniqueOrder(...groups:ProviderName[][]){const out:ProviderName[]=[];for(const g of groups)for(const p of g)if(!out.includes(p)&&BASE_ORDER.includes(p))out.push(p);return out;}
export function methodAwareOrder(method:string):ProviderName[]{
  if(TRACKER_EFFICIENT.has(method))return uniqueOrder(["solana_tracker","chainstack","alchemy","helius"],BASE_ORDER);
  if(HISTORICAL_HEAVY.has(method))return uniqueOrder(["chainstack","alchemy","solana_tracker","helius"],BASE_ORDER);
  return uniqueOrder(["chainstack","alchemy","solana_tracker","helius"],BASE_ORDER);
}
async function callProvider(p:ProviderName,method:string,params:unknown[]){const url=URLS[p];if(!url)throw new Error(`${p}:not_configured`);const wait=Math.max(0,(nextAt[p]||0)-Date.now());if(wait)await sleep(wait);nextAt[p]=Date.now()+Math.max(25,MIN_INTERVAL[p]||100);const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT_MS),started=Date.now();try{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:rpcId++,method,params}),signal:c.signal});const text=await r.text();if(!r.ok){const e:ProviderError=new Error(`${p}:${r.status}:${text.slice(0,180)}`);e.status=r.status;e.retryAfterMs=retryAfterMs(r.headers.get("retry-after"));throw e;}const body=text?JSON.parse(text):null;if(body?.error)throw new Error(`${p}:rpc:${JSON.stringify(body.error).slice(0,220)}`);return{result:body?.result,latencyMs:Date.now()-started};}finally{clearTimeout(t);}}
function applyFailureCooldown(p:ProviderName,e:ProviderError){if(e?.status===429){cool(p,Math.max(RATE_LIMIT_COOLDOWN_MS,e.retryAfterMs||0));return;}if(e?.status===408||e?.status===425||(e?.status!=null&&e.status>=500)){cool(p,TRANSIENT_COOLDOWN_MS);return;}if(e?.name==="AbortError"||e?.status==null)cool(p,TRANSIENT_COOLDOWN_MS);}
export function providerFabricEnabled(){return ENABLED;}
export function configuredRpcProviders(){return BASE_ORDER.filter(p=>Boolean(URLS[p]));}
export async function smokeProbeProvider(p:ProviderName,method="getLatestBlockhash",params:unknown[]=[{commitment:"confirmed"}]){if(!URLS[p])throw new Error(`${p}:not_configured`);const state=await readState(),h=health(state,p);recordAttempt(h,p,method);try{const x=await callProvider(p,method,params);recordSuccess(h,method,x.latencyMs);cooldownUntil[p]=0;await saveState(state);return{provider:p,result:x.result,latencyMs:x.latencyMs};}catch(e:any){recordFailure(h,method,e?.status===429);applyFailureCooldown(p,e);h.lastError=String(e).slice(0,500);await saveState(state);throw e;}}
export async function routedRpc(method:string,params:unknown[]=[],opts:{preferred?:ProviderName[];verify?:boolean}={}){if(!ENABLED)throw new Error("provider_fabric_disabled");const state=await readState();const initial=(opts.preferred?.length?opts.preferred:methodAwareOrder(method)).filter(p=>Boolean(URLS[p]));if(!initial.length)throw new Error("provider_fabric_no_rpc_provider");const lifetime=Object.fromEntries(initial.map(p=>[p,health(state,p).requests])) as Partial<Record<ProviderName,number>>;const candidates=opts.preferred?.length?initial:await allocateProviders(method,initial,lifetime);let last:unknown,budgetBlocked=0;for(const p of candidates){if(isCooling(p))continue;const units=estimatedUnits(p,method);if(!(await providerAllowed(p,units))){budgetBlocked++;continue;}const h=health(state,p);recordAttempt(h,p,method);await recordProviderBurn(p,units);try{const x=await callProvider(p,method,params);recordSuccess(h,method,x.latencyMs);cooldownUntil[p]=0;await saveState(state);if(opts.verify&&p!=="helius"&&URLS.helius){const vh=health(state,"helius"),vunits=estimatedUnits("helius",method);if(await providerAllowed("helius",vunits)){recordAttempt(vh,"helius",method);await recordProviderBurn("helius",vunits);try{const v=await callProvider("helius",method,params);recordSuccess(vh,method,v.latencyMs);if(JSON.stringify(v.result)!==JSON.stringify(x.result))throw new Error(`provider_disagreement:${p}:helius`);await saveState(state);}catch(e:any){recordFailure(vh,method,e?.status===429);vh.lastError=String(e).slice(0,500);await saveState(state);throw e;}}}return{provider:p,result:x.result};}catch(e:any){last=e;recordFailure(h,method,e?.status===429);applyFailureCooldown(p,e);h.lastError=String(e).slice(0,500);await saveState(state);}}
const cooling=candidates.map(p=>({p,until:cooldownUntil[p]||0})).filter(x=>x.until>Date.now()).sort((a,b)=>a.until-b.until);if(cooling.length+budgetBlocked===candidates.length&&cooling.length){await sleep(Math.max(0,cooling[0].until-Date.now()));return routedRpc(method,params,opts);}if(budgetBlocked===candidates.length)throw new Error("provider_fabric_all_soft_budgets_exhausted");throw last instanceof Error?last:new Error(String(last||"provider_fabric_rpc_failed"));}
export async function providerFabricReport(){const state=await readState(),now=Date.now(),budget=await providerBudgetSnapshot();return{event:"shark_scout_provider_fabric",enabled:ENABLED,configured:configuredRpcProviders(),baseOrder:BASE_ORDER,allocation:"method_specialty_then_budget_pressure_then_lifetime_requests",budget,unitModels:{chainstack:"logical generic-RPC request unit; optional soft budget",solana_tracker:"estimated documented credits by method; governed daily soft budget",alchemy:"logical generic-RPC request unit; optional soft budget",helius:"generic RPC logical unit only; specialty/enriched APIs excluded"},providers:Object.fromEntries(Object.entries(state.providers).map(([k,v])=>[k,{...v,successRate:v.requests?v.successes/v.requests:null,avgLatencyMs:v.successes?v.latencyMsTotal/v.successes:null,cooldownRemainingMs:Math.max(0,(cooldownUntil[k as ProviderName]||0)-now)}]))};}
