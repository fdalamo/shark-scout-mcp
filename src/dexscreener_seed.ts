import { PublicKey } from "@solana/web3.js";
import { getDexScreenerMarketStates, type MarketState } from "./market_state_cache.js";

const TIMEOUT_MS=Math.max(3000,Math.min(60000,Number(process.env.REQUEST_TIMEOUT_MS||25000)));
const SEED_LIMIT=Math.max(6,Math.min(30,Number(process.env.DEXSCREENER_SEED_LIMIT||14)));
const LIST_INTERVAL_MS=Math.max(1100,Number(process.env.DEXSCREENER_LIST_INTERVAL_MS||1250));
export type DexSeed={pool:string;mint:string;symbol:string|null;liquidity:number;volume24h:number;tx24h:number;priceChange24h:number|null;createdAt:string|null;sourceTags:string[];score:number};
export type DexSeedReport={seeds:DexSeed[];requests:number;errors:string[];rawTokens:number;qualifiedPools:number;marketCache:{cacheHits:number;cacheMisses:number;batches:number}};
function pk(v:any){if(typeof v!=="string")return null;try{return new PublicKey(v).toBase58();}catch{return null;}}
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
async function get(url:string){const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT_MS);try{const r=await fetch(url,{headers:{Accept:"application/json"},signal:c.signal});const s=await r.text();if(!r.ok)throw new Error(`${r.status}:${s.slice(0,160)}`);return s?JSON.parse(s):null;}finally{clearTimeout(t);}}
function seedToken(row:any){if(String(row?.chainId||"").toLowerCase()!=="solana")return null;return pk(row?.tokenAddress);}
function marketSeed(mint:string,m:MarketState,tags:string[]):DexSeed|null{if(!m.pairAddress)return null;const liq=m.liquidityUsd,vol=m.volume24h,tx=m.tx24h,pc=m.priceChange24h,createdMs=m.pairCreatedAt?Date.parse(m.pairCreatedAt):0,ageH=createdMs>0?(Date.now()-createdMs)/3600000:99999;const promoOnly=tags.every(x=>x!=="community_takeover"&&x!=="profile");const minLiq=promoOnly?30000:20000,minVol=promoOnly?100000:60000,minTx=promoOnly?150:90;if(liq<minLiq||vol<minVol||tx<minTx)return null;if(ageH>24*14&&Math.abs(pc||0)<10)return null;const sourceDiversity=new Set(tags).size,score=Math.min(10,liq/75000)+Math.min(10,vol/300000)+Math.min(8,tx/350)+Math.min(8,Math.max(0,pc||0)/35)+sourceDiversity*4-(promoOnly?4:0);return{pool:m.pairAddress,mint,symbol:m.symbol,liquidity:liq,volume24h:vol,tx24h:tx,priceChange24h:pc,createdAt:m.pairCreatedAt,sourceTags:[...new Set(tags)],score};}

export async function discoverDexScreenerSeeds():Promise<DexSeedReport>{const errors:string[]=[],tagByToken=new Map<string,Set<string>>();let requests=0;const lists:[string,string][]=[
["https://api.dexscreener.com/token-profiles/latest/v1","profile"],
["https://api.dexscreener.com/community-takeovers/latest/v1","community_takeover"],
["https://api.dexscreener.com/token-boosts/latest/v1","boost_latest"],
["https://api.dexscreener.com/token-boosts/top/v1","boost_top"]];
for(const[url,tag]of lists){try{const body=await get(url);requests++;for(const row of Array.isArray(body)?body:[body]){const t=seedToken(row);if(!t)continue;const s=tagByToken.get(t)||new Set<string>();s.add(tag);tagByToken.set(t,s);}}catch(e){errors.push(`${tag}:${String(e)}`);}await sleep(LIST_INTERVAL_MS);}
const tokens=[...tagByToken.keys()].slice(0,90);const market=await getDexScreenerMarketStates(tokens,"COLD");requests+=market.telemetry.requests;errors.push(...market.telemetry.errors.map(e=>`market_cache:${e}`));const all:DexSeed[]=[];for(const mint of tokens){const row=market.states[mint];if(!row)continue;const seed=marketSeed(mint,row,[...(tagByToken.get(mint)||[])]);if(seed)all.push(seed);}const best=new Map<string,DexSeed>();for(const s of all){const old=best.get(s.pool);if(!old||s.score>old.score)best.set(s.pool,s);}const seeds=[...best.values()].sort((a,b)=>b.score-a.score).slice(0,SEED_LIMIT);return{seeds,requests,errors,rawTokens:tokens.length,qualifiedPools:best.size,marketCache:{cacheHits:market.telemetry.cacheHits,cacheMisses:market.telemetry.cacheMisses,batches:market.telemetry.batches}};}
