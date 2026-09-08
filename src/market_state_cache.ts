import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

export type MarketFreshness="HOT"|"COLD";
export type MarketState={mint:string;source:"dexscreener";fetchedAt:string;pairAddress:string|null;dexId:string|null;symbol:string|null;priceUsd:number|null;liquidityUsd:number;fdv:number|null;marketCap:number|null;volume24h:number;tx24h:number;priceChange24h:number|null;pairCreatedAt:string|null};
type CacheFile={schemaVersion:1;updatedAt:string;entries:Record<string,MarketState>};
export type MarketStateResult={states:Record<string,MarketState|null>;telemetry:{requested:number;cacheHits:number;cacheMisses:number;batches:number;requests:number;errors:string[]}};

const CACHE_PATH=process.env.SCOUT_MARKET_STATE_CACHE_PATH||"/data/market-state-cache.json";
const HOT_TTL_MS=Math.max(15000,Number(process.env.MARKET_STATE_HOT_TTL_MS||60000));
const COLD_TTL_MS=Math.max(HOT_TTL_MS,Number(process.env.MARKET_STATE_COLD_TTL_MS||300000));
const TIMEOUT_MS=Math.max(3000,Math.min(60000,Number(process.env.REQUEST_TIMEOUT_MS||25000)));
const MIN_INTERVAL_MS=Math.max(200,Number(process.env.DEXSCREENER_FAST_INTERVAL_MS||350));
const QUOTES=new Set(["So11111111111111111111111111111111111111112","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
let nextAt=0;
function n(v:any,d=0){const x=Number(v);return Number.isFinite(x)?x:d;}
function nullableNumber(v:any){const x=Number(v);return Number.isFinite(x)?x:null;}
function pk(v:any){if(typeof v!=="string")return null;try{return new PublicKey(v).toBase58();}catch{return null;}}
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
async function readCache():Promise<CacheFile>{try{const x=JSON.parse(await fs.readFile(CACHE_PATH,"utf8"));return{schemaVersion:1,updatedAt:x?.updatedAt||new Date(0).toISOString(),entries:x?.entries||{}};}catch{return{schemaVersion:1,updatedAt:new Date().toISOString(),entries:{}};}}
async function writeCache(c:CacheFile){await fs.mkdir(path.dirname(CACHE_PATH),{recursive:true});c.updatedAt=new Date().toISOString();const tmp=`${CACHE_PATH}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(c));await fs.rename(tmp,CACHE_PATH);}
async function dexGet(url:string){const wait=Math.max(0,nextAt-Date.now());if(wait)await sleep(wait);nextAt=Date.now()+MIN_INTERVAL_MS;const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT_MS);try{const r=await fetch(url,{headers:{Accept:"application/json"},signal:c.signal});const text=await r.text();if(!r.ok)throw new Error(`${r.status}:${text.slice(0,180)}`);return text?JSON.parse(text):null;}finally{clearTimeout(t);}}
function mintForPair(p:any){const ba=pk(p?.baseToken?.address),qa=pk(p?.quoteToken?.address);return ba&&!QUOTES.has(ba)?ba:qa&&!QUOTES.has(qa)?qa:null;}
function normalizePair(mint:string,p:any):MarketState{const created=n(p?.pairCreatedAt);return{mint,source:"dexscreener",fetchedAt:new Date().toISOString(),pairAddress:pk(p?.pairAddress),dexId:typeof p?.dexId==="string"?p.dexId:null,symbol:typeof p?.baseToken?.symbol==="string"?p.baseToken.symbol:null,priceUsd:nullableNumber(p?.priceUsd),liquidityUsd:n(p?.liquidity?.usd),fdv:nullableNumber(p?.fdv),marketCap:nullableNumber(p?.marketCap),volume24h:n(p?.volume?.h24),tx24h:n(p?.txns?.h24?.buys)+n(p?.txns?.h24?.sells),priceChange24h:nullableNumber(p?.priceChange?.h24),pairCreatedAt:created>0?new Date(created).toISOString():null};}
function better(a:MarketState|undefined,b:MarketState){if(!a)return true;if(b.liquidityUsd!==a.liquidityUsd)return b.liquidityUsd>a.liquidityUsd;if(b.volume24h!==a.volume24h)return b.volume24h>a.volume24h;return b.tx24h>a.tx24h;}
export async function getDexScreenerMarketStates(mints:string[],freshness:MarketFreshness="COLD"):Promise<MarketStateResult>{const valid=[...new Set(mints.map(pk).filter((x):x is string=>Boolean(x)))],cache=await readCache(),now=Date.now(),ttl=freshness==="HOT"?HOT_TTL_MS:COLD_TTL_MS;const states:Record<string,MarketState|null>={},misses:string[]=[];let cacheHits=0;for(const mint of valid){const row=cache.entries[mint],age=row?now-Date.parse(row.fetchedAt):Infinity;if(row&&Number.isFinite(age)&&age<=ttl){states[mint]=row;cacheHits++;}else misses.push(mint);}let requests=0,batches=0;const errors:string[]=[];for(let i=0;i<misses.length;i+=30){const batch=misses.slice(i,i+30);batches++;try{const body=await dexGet(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`);requests++;const best=new Map<string,MarketState>();for(const p of Array.isArray(body)?body:[]){const mint=mintForPair(p);if(!mint||!batch.includes(mint))continue;const row=normalizePair(mint,p);if(better(best.get(mint),row))best.set(mint,row);}for(const mint of batch){const row=best.get(mint);if(row){cache.entries[mint]=row;states[mint]=row;}else states[mint]=null;}}catch(e){errors.push(String(e));for(const mint of batch)states[mint]=cache.entries[mint]||null;}}if(misses.length)await writeCache(cache);return{states,telemetry:{requested:valid.length,cacheHits,cacheMisses:misses.length,batches,requests,errors}};}
