import { promises as fs } from "node:fs";
import path from "node:path";

type ProviderName = "chainstack"|"solana_tracker"|"alchemy"|"helius";
type Health = { requests:number; successes:number; failures:number; rateLimited:number; latencyMsTotal:number; lastError?:string; lastUsedAt?:string };
type State = { schemaVersion:1; updatedAt:string; providers:Record<string,Health> };

const ENABLED = /^(1|true|yes)$/i.test(process.env.PROVIDER_FABRIC_ENABLED || "false");
const STATE_PATH = process.env.PROVIDER_FABRIC_STATE_PATH || "/data/provider-fabric-state.json";
const TIMEOUT_MS = Math.max(3000, Math.min(60000, Number(process.env.PROVIDER_FABRIC_TIMEOUT_MS || 25000)));
const URLS:Record<ProviderName,string|undefined> = {
  chainstack: process.env.CHAINSTACK_SOLANA_RPC_URL?.trim(),
  solana_tracker: process.env.SOLANA_TRACKER_RPC_URL?.trim() || (process.env.SOLANA_TRACKER_API_KEY?.trim() ? `https://rpc-mainnet.solanatracker.io/?api_key=${process.env.SOLANA_TRACKER_API_KEY.trim()}` : undefined),
  alchemy: process.env.ALCHEMY_SOLANA_RPC_URL?.trim(),
  helius: process.env.SOLANA_RPC_URL?.trim() || (process.env.HELIUS_API_KEY?.trim() ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY.trim()}` : undefined)
};
const ORDER:ProviderName[] = String(process.env.PROVIDER_FABRIC_RPC_ORDER || "chainstack,solana_tracker,alchemy,helius").split(",").map(x=>x.trim()).filter((x):x is ProviderName=>x in URLS);
const MIN_INTERVAL:Record<ProviderName,number> = {
  chainstack: Number(process.env.CHAINSTACK_MIN_INTERVAL_MS || 50),
  solana_tracker: Number(process.env.SOLANA_TRACKER_MIN_INTERVAL_MS || 120),
  alchemy: Number(process.env.ALCHEMY_MIN_INTERVAL_MS || 150),
  helius: Number(process.env.PROVIDER_FABRIC_HELIUS_MIN_INTERVAL_MS || 120)
};
const nextAt:Partial<Record<ProviderName,number>> = {};
let rpcId=1;
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
async function readState():Promise<State>{try{return JSON.parse(await fs.readFile(STATE_PATH,"utf8"));}catch{return{schemaVersion:1,updatedAt:new Date().toISOString(),providers:{}};}}
async function saveState(s:State){await fs.mkdir(path.dirname(STATE_PATH),{recursive:true});s.updatedAt=new Date().toISOString();const tmp=`${STATE_PATH}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(s));await fs.rename(tmp,STATE_PATH);}
function health(s:State,p:ProviderName){return s.providers[p] ||= {requests:0,successes:0,failures:0,rateLimited:0,latencyMsTotal:0};}
async function callProvider(p:ProviderName,method:string,params:unknown[]){const url=URLS[p];if(!url)throw new Error(`${p}:not_configured`);const wait=Math.max(0,(nextAt[p]||0)-Date.now());if(wait)await sleep(wait);nextAt[p]=Date.now()+Math.max(25,MIN_INTERVAL[p]||100);const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT_MS),started=Date.now();try{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:rpcId++,method,params}),signal:c.signal});const text=await r.text();if(!r.ok){const e:any=new Error(`${p}:${r.status}:${text.slice(0,180)}`);e.status=r.status;throw e;}const body=text?JSON.parse(text):null;if(body?.error)throw new Error(`${p}:rpc:${JSON.stringify(body.error).slice(0,220)}`);return {result:body?.result,latencyMs:Date.now()-started};}finally{clearTimeout(t);}}
export function providerFabricEnabled(){return ENABLED;}
export function configuredRpcProviders(){return ORDER.filter(p=>Boolean(URLS[p]));}
export async function routedRpc(method:string,params:unknown[]=[],opts:{preferred?:ProviderName[];verify?:boolean}={}){
  if(!ENABLED)throw new Error("provider_fabric_disabled");
  const state=await readState();const candidates=(opts.preferred?.length?opts.preferred:ORDER).filter(p=>Boolean(URLS[p]));if(!candidates.length)throw new Error("provider_fabric_no_rpc_provider");let last:unknown;
  for(const p of candidates){const h=health(state,p);h.requests++;h.lastUsedAt=new Date().toISOString();try{const x=await callProvider(p,method,params);h.successes++;h.latencyMsTotal+=x.latencyMs;await saveState(state);
      if(opts.verify && p!=="helius" && URLS.helius){try{const v=await callProvider("helius",method,params);const vh=health(state,"helius");vh.requests++;vh.successes++;vh.latencyMsTotal+=v.latencyMs;if(JSON.stringify(v.result)!==JSON.stringify(x.result))throw new Error(`provider_disagreement:${p}:helius`);await saveState(state);}catch(e){h.lastError=String(e);await saveState(state);throw e;}}
      return {provider:p,result:x.result};
    }catch(e:any){last=e;h.failures++;if(e?.status===429)h.rateLimited++;h.lastError=String(e).slice(0,500);await saveState(state);}
  }
  throw last instanceof Error?last:new Error(String(last||"provider_fabric_rpc_failed"));
}
export async function providerFabricReport(){const state=await readState();return {event:"shark_scout_provider_fabric",enabled:ENABLED,configured:configuredRpcProviders(),order:ORDER,providers:Object.fromEntries(Object.entries(state.providers).map(([k,v])=>[k,{...v,successRate:v.requests?v.successes/v.requests:null,avgLatencyMs:v.successes?v.latencyMsTotal/v.successes:null}]))};}
