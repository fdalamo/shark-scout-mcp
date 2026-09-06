import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY?.trim();
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");
const STATE_PATH = process.env.SCOUT_STATE_PATH || "./data/shark-state.json";
const REPORT_PATH = process.env.SCOUT_REPORT_PATH || "./data/latest-harvest.json";
const HELIUS_CACHE_PATH = process.env.SCOUT_HELIUS_CACHE_PATH || "./data/helius-cache.json";
const TOKEN_LIMIT = clamp(Number(process.env.HARVEST_TOKEN_LIMIT || 50), 5, 50);
const TRADERS_PER_TOKEN = clamp(Number(process.env.HARVEST_TRADERS_PER_TOKEN || 10), 3, 10);
const PROFILE_LIMIT = clamp(Number(process.env.HARVEST_PROFILE_LIMIT || 60), 0, 160);
const GLOBAL_WALLET_LIMIT = clamp(Number(process.env.HARVEST_GLOBAL_WALLET_LIMIT || 160), 40, 500);
const PROFILE_STALE_MINUTES = clamp(Number(process.env.HARVEST_PROFILE_STALE_MINUTES || 180), 30, 1440);
const CACHE_KEEP_HOURS = clamp(Number(process.env.HARVEST_CACHE_KEEP_HOURS || 12), 3, 72);
const CACHE_MAX_WALLETS = clamp(Number(process.env.HARVEST_CACHE_MAX_WALLETS || 1200), 100, 5000);
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 25000), 3000, 60000);
const BIRDEYE_MIN_INTERVAL_MS = clamp(Number(process.env.BIRDEYE_MIN_INTERVAL_MS || 1600), 1100, 10000);
const HELIUS_MIN_INTERVAL_MS = clamp(Number(process.env.HARVEST_HELIUS_MIN_INTERVAL_MS || 180), 100, 3000);
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

type WalletStatus="RAW"|"CHEAP_PASS"|"PROFILED"|"REJECTED"|"UNKNOWN";
type Wallet={address:string;firstSeen:string;lastSeen:string;rediscoveryCount:number;tokens:string[];providers:string[];lanes:string[];tags:string[];status:WalletStatus;rejectionReason?:string;lastProfiledAt?:string;discovery?:Record<string,any>;profile?:Record<string,any>};
type State={schemaVersion:number;createdAt:string;updatedAt:string;wallets:Record<string,Wallet>;tokens:Record<string,{firstSeen:string;lastSeen:string;providers:string[];hits:number}>;runs:Array<Record<string,unknown>>};
type HeliusCache={schemaVersion:number;updatedAt:string;wallets:Record<string,{fetchedAt:string;rows:any[]}>};

function clamp(n:number,min:number,max:number){return Math.max(min,Math.min(max,Number.isFinite(n)?Math.floor(n):min));}
function now(){return new Date().toISOString();}
function uniq<T>(x:T[]){return [...new Set(x)];}
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
function retryableStatus(s:number){return s===408||s===425||s===429||s>=500;}
async function fetchJson(url:string,init:RequestInit={},attempts=3){let last:Error|undefined;for(let a=0;a<attempts;a++){const c=new AbortController();const t=setTimeout(()=>c.abort(),TIMEOUT_MS);try{const r=await fetch(url,{...init,signal:c.signal});const text=await r.text();if(r.ok)return text?JSON.parse(text):null;last=new Error(`${r.status} ${text.slice(0,220)}`);if(!retryableStatus(r.status)||a===attempts-1)throw last;const ra=Number(r.headers.get("retry-after"));await sleep(Number.isFinite(ra)&&ra>0?ra*1000:900*(2**a)+Math.floor(Math.random()*350));}catch(e){last=e instanceof Error?e:new Error(String(e));if(a===attempts-1)throw last;await sleep(700*(2**a)+Math.floor(Math.random()*350));}finally{clearTimeout(t);}}throw last||new Error("fetch failed");}

let rpcId=1;async function rpc(method:string,params:unknown[]=[]){const b=await fetchJson(RPC_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:rpcId++,method,params})},3);if(b?.error)throw new Error(JSON.stringify(b.error));return b?.result;}
function pubkey(v:unknown):string|null{if(typeof v!=="string")return null;try{return new PublicKey(v).toBase58();}catch{return null;}}
function objectsDeep(v:unknown,d=0):any[]{if(d>6||v==null)return[];if(Array.isArray(v))return v.flatMap(x=>[...(x&&typeof x==="object"&&!Array.isArray(x)?[x]:[]),...objectsDeep(x,d+1)]);if(typeof v==="object")return Object.values(v as Record<string,unknown>).flatMap(x=>objectsDeep(x,d+1));return[];}
function tokenAddresses(payload:any){const out:string[]=[];for(const r of objectsDeep(payload))for(const k of ["address","mint","tokenAddress","token_address"]){const x=pubkey(r?.[k]);if(x)out.push(x);}return uniq(out);}
function walletAddress(r:any){for(const k of ["wallet","owner","address","walletAddress","wallet_address","trader","user","authority"]){const x=pubkey(r?.[k]);if(x)return x;}return null;}
function tagsFrom(r:any){return uniq([r?.tag,r?.tags,r?.walletTags,r?.wallet_tags,r?.identity?.tags,r?.identity?.platform,r?.identity?.name].flat(Infinity).filter(Boolean).map((x:any)=>String(x).toLowerCase()));}
function badTag(tags:string[]){const s=tags.join(" ");for(const x of ["sniper","bundler","insider","developer","bot","mev","exchange","cex"])if(s.includes(x))return x;return null;}

let birdNextAt=0;async function bird(pathname:string,q:URLSearchParams){const wait=Math.max(0,birdNextAt-Date.now());if(wait)await sleep(wait);birdNextAt=Math.max(Date.now(),birdNextAt)+BIRDEYE_MIN_INTERVAL_MS;return fetchJson(`https://public-api.birdeye.so${pathname}?${q}`,{headers:{"X-API-KEY":BIRDEYE_API_KEY!,"x-chain":"solana"}},4);}
let heliusNextAt=0;async function heliusGate(){const wait=Math.max(0,heliusNextAt-Date.now());if(wait)await sleep(wait);heliusNextAt=Math.max(Date.now(),heliusNextAt)+HELIUS_MIN_INTERVAL_MS;}
async function trending(){if(!BIRDEYE_API_KEY)return[];const q=new URLSearchParams({sort_by:"rank",sort_type:"asc",interval:"24h",offset:"0",limit:String(TOKEN_LIMIT)});return tokenAddresses(await bird("/defi/token_trending",q)).slice(0,TOKEN_LIMIT);}
async function topTraders(mint:string){if(!BIRDEYE_API_KEY)return[];const q=new URLSearchParams({address:mint,time_frame:"30d",sort_type:"desc",sort_by:"realized_pnl",offset:"0",limit:String(TRADERS_PER_TOKEN),min_trade:"2"});const b=await bird("/defi/v2/tokens/top_traders",q);return objectsDeep(b).filter(x=>walletAddress(x)).slice(0,TRADERS_PER_TOKEN);}
async function entityType(address:string){try{const v=(await rpc("getAccountInfo",[address,{encoding:"base64",commitment:"confirmed"}]))?.value;if(!v)return{valid:true};if(v.executable)return{valid:false,reason:"executable_program"};if(TOKEN_PROGRAMS.has(v.owner))return{valid:false,reason:"token_account"};return{valid:true};}catch{return{valid:true,reason:"entity_validation_unknown"};}}
async function heliusRecent(address:string){if(!HELIUS_API_KEY)return null;try{await heliusGate();const q=new URLSearchParams({"api-key":HELIUS_API_KEY,limit:"50",type:"SWAP"});let x:any;try{x=await fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${q}`,{},3);}catch(e){q.delete("type");x=await fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${q}`,{},3);}return Array.isArray(x)?x:null;}catch{return null;}}
function summarizeHelius(rows:any[]|null){if(!rows)return null;const swaps=rows.filter(x=>x?.type==="SWAP");const ts=rows.map(x=>Number(x?.timestamp)).filter(Number.isFinite);return{transactionsFetched:rows.length,swapsFetched:swaps.length,newestTimestamp:ts.length?Math.max(...ts):null,oldestTimestamp:ts.length?Math.min(...ts):null};}
async function loadState():Promise<State>{try{const p=JSON.parse(await fs.readFile(STATE_PATH,"utf8"));return{schemaVersion:5,createdAt:p.createdAt||now(),updatedAt:p.updatedAt||now(),wallets:p.wallets||{},tokens:p.tokens||{},runs:Array.isArray(p.runs)?p.runs:[]};}catch{const t=now();return{schemaVersion:5,createdAt:t,updatedAt:t,wallets:{},tokens:{},runs:[]};}}
async function loadCache():Promise<HeliusCache>{try{const p=JSON.parse(await fs.readFile(HELIUS_CACHE_PATH,"utf8"));return{schemaVersion:1,updatedAt:p.updatedAt||now(),wallets:p.wallets||{}};}catch{return{schemaVersion:1,updatedAt:now(),wallets:{}};}}
async function save(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function score(w:Wallet){return(w.tokens?.length||0)*1000+Math.min(w.rediscoveryCount||0,999);}
function profileDue(w:Wallet){if(!w.lastProfiledAt)return true;const t=Date.parse(w.lastProfiledAt);return !Number.isFinite(t)||Date.now()-t>=PROFILE_STALE_MINUTES*60_000;}
function upsert(state:State,row:any,mint:string){const a=walletAddress(row);if(!a)return false;const t=now(),tags=tagsFrom(row),e=state.wallets[a];if(!e){state.wallets[a]={address:a,firstSeen:t,lastSeen:t,rediscoveryCount:1,tokens:[mint],providers:["birdeye"],lanes:["TOKEN_WINNER"],tags,status:"RAW",discovery:{birdeye:{realizedPnl:row?.realizedPnl??row?.realized_pnl??null,unrealizedPnl:row?.unrealizedPnl??row?.unrealized_pnl??null}}};return true;}e.lastSeen=t;e.rediscoveryCount=(e.rediscoveryCount||0)+1;e.tokens=uniq([...(e.tokens||[]),mint]);e.providers=uniq([...(e.providers||[]),"birdeye"]);e.tags=uniq([...(e.tags||[]),...tags]);if(e.tokens.length>=2)e.lanes=uniq([...(e.lanes||[]),"CROSS_TOKEN"]);return false;}
function pruneCache(cache:HeliusCache){const cutoff=Date.now()-CACHE_KEEP_HOURS*3600_000;const entries=Object.entries(cache.wallets).filter(([,v])=>Date.parse(v.fetchedAt)>=cutoff).sort((a,b)=>Date.parse(b[1].fetchedAt)-Date.parse(a[1].fetchedAt)).slice(0,CACHE_MAX_WALLETS);cache.wallets=Object.fromEntries(entries);cache.updatedAt=now();}

export async function runHarvest(){
  const startedAt=now(),state=await loadState(),cache=await loadCache(),before=Object.keys(state.wallets).length,providerErrors:string[]=[];let raw=0,dupes=0,screened=0,invalid=0,tagRejected=0,profiled=0,unknown=0,cacheWrites=0;let tokens:string[]=[];
  try{tokens=await trending();}catch(e){providerErrors.push(`birdeye_trending:${String(e)}`);}
  for(const mint of tokens){const t=now(),old=state.tokens[mint];state.tokens[mint]=old?{...old,lastSeen:t,providers:uniq([...(old.providers||[]),"birdeye"]),hits:(old.hits||0)+1}:{firstSeen:t,lastSeen:t,providers:["birdeye"],hits:1};try{for(const row of await topTraders(mint)){raw++;if(!upsert(state,row,mint))dupes++;}}catch(e){providerErrors.push(`birdeye_top_traders:${mint}:${String(e)}`);}}

  const ranked=Object.values(state.wallets).filter(w=>w.status!=="REJECTED").sort((a,b)=>score(b)-score(a));
  const screenTargets=ranked.filter(w=>w.status==="RAW").slice(0,GLOBAL_WALLET_LIMIT);
  for(const w of screenTargets){const bad=badTag(w.tags||[]);if(bad){w.status="REJECTED";w.rejectionReason=`tag:${bad}`;tagRejected++;continue;}const ent=await entityType(w.address);screened++;if(!ent.valid){w.status="REJECTED";w.rejectionReason=ent.reason||"invalid_entity";invalid++;continue;}w.status="CHEAP_PASS";}

  const profileTargets=Object.values(state.wallets).filter(w=>["CHEAP_PASS","PROFILED","UNKNOWN"].includes(w.status)&&profileDue(w)).sort((a,b)=>{const ap=a.lastProfiledAt?1:0,bp=b.lastProfiledAt?1:0;if(ap!==bp)return ap-bp;return score(b)-score(a);}).slice(0,PROFILE_LIMIT);
  for(const w of profileTargets){const rows=await heliusRecent(w.address),h=summarizeHelius(rows);w.lastProfiledAt=now();w.profile={...(w.profile||{}),heliusRecent:h};if(rows){cache.wallets[w.address]={fetchedAt:w.lastProfiledAt,rows};cacheWrites++;}if(h){w.status="PROFILED";delete w.rejectionReason;profiled++;}else{w.status="UNKNOWN";w.rejectionReason="helius_profile_unavailable";unknown++;}}

  pruneCache(cache);await save(HELIUS_CACHE_PATH,cache);
  const total=Object.keys(state.wallets).length,cross=Object.values(state.wallets).filter(w=>(w.tokens?.length||0)>=2).length,rejected=Object.values(state.wallets).filter(w=>w.status==="REJECTED").length,rawRemaining=Object.values(state.wallets).filter(w=>w.status==="RAW").length,profileDueRemaining=Object.values(state.wallets).filter(w=>["CHEAP_PASS","PROFILED","UNKNOWN"].includes(w.status)&&profileDue(w)).length;
  const telemetry={startedAt,finishedAt:now(),providers:{helius:Boolean(HELIUS_API_KEY),birdeye:Boolean(BIRDEYE_API_KEY),vybe:"gauntlet_only_free_trades"},tokensExamined:tokens.length,rawWalletHits:raw,newUniqueWallets:Math.max(total-before,0),duplicates:dupes,cheapScreened:screened,invalidEntities:invalid,tagRejected,profiled,unknown,cumulativeUniqueWallets:total,cumulativeRejectedWallets:rejected,crossTokenWallets:cross,rawRemaining,profileDueRemaining,profileStaleMinutes:PROFILE_STALE_MINUTES,heliusCacheWrites:cacheWrites,heliusCacheWallets:Object.keys(cache.wallets).length,providerErrors};
  state.updatedAt=now();state.runs=[...state.runs.slice(-199),telemetry];await save(STATE_PATH,state);
  const top=Object.values(state.wallets).filter(w=>w.status==="PROFILED").sort((a,b)=>score(b)-score(a)).slice(0,50).map(w=>({address:w.address,status:w.status,uniqueTokensSeen:w.tokens?.length||0,rediscoveryCount:w.rediscoveryCount,providers:w.providers,profile:w.profile}));
  const report={schemaVersion:5,generatedAt:now(),telemetry,note:"Free-tier-safe adaptive harvest with reusable Helius recent-history cache. Birdeye requests are paced/retried; entity validation focuses on new RAW wallets; Helius profiling rotates through unprofiled/stale wallets. Cached recent rows are handed to gauntlet v5 to avoid duplicate provider work.",rankedDiscoveryCandidates:top};await save(REPORT_PATH,report);return report;
}

if(import.meta.url===`file://${process.argv[1]}`)runHarvest().then((r:any)=>console.log(JSON.stringify({event:"shark_scout_harvest_complete",telemetry:r.telemetry,topCandidates:r.rankedDiscoveryCandidates.slice(0,5)}))).catch(e=>{console.error(JSON.stringify({event:"shark_scout_harvest_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
