import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const BIRDEYE_KEY=process.env.BIRDEYE_API_KEY?.trim();
const STATE_PATH=process.env.SCOUT_STATE_PATH||"./data/shark-state.json";
const OUT_PATH=process.env.SCOUT_OUTCOME_MINER_PATH||"./data/outcome-miner.json";
const POLL_HOURS=clamp(Number(process.env.OUTCOME_MINER_POLL_HOURS||6),2,24);
const TOKENS_PER_COHORT=clamp(Number(process.env.OUTCOME_MINER_TOKENS_PER_COHORT||12),4,30);
const MAX_TOKEN_CALLS=clamp(Number(process.env.OUTCOME_MINER_MAX_TOKEN_CALLS||24),8,50);
const TRADERS_PER_TOKEN=clamp(Number(process.env.OUTCOME_MINER_TRADERS_PER_TOKEN||6),3,10);
const MIN_INTERVAL_MS=clamp(Number(process.env.BIRDEYE_MIN_INTERVAL_MS||1600),1100,10000);
const TIMEOUT_MS=clamp(Number(process.env.REQUEST_TIMEOUT_MS||25000),3000,60000);

type AnyObj=Record<string,any>;
type Cohort="BREAKOUT_24H"|"FRESH_TRACTION"|"LIQUID_ACTIVE";
type TokenLead={mint:string;cohort:Cohort;symbol:string|null;liquidity:number|null;marketCap:number|null;volume24h:number|null;priceChange24h:number|null;recentListingTime:number|null;score:number};
type WalletLead={address:string;tokens:Set<string>;cohorts:Set<Cohort>;hits:number;realizedPnl:number;positivePnlRows:number;providerRows:number;tokenEvidence:TokenLead[]};

function clamp(n:number,min:number,max:number){return Math.max(min,Math.min(max,Number.isFinite(n)?Math.floor(n):min));}
function now(){return new Date().toISOString();}
function uniq<T>(xs:T[]){return [...new Set(xs)];}
function finite(v:any){const n=Number(v);return Number.isFinite(n)?n:null;}
function pk(v:any){if(typeof v!=="string")return null;try{return new PublicKey(v).toBase58();}catch{return null;}}
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
async function json(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}

let nextAt=0;
async function bird(pathname:string,q:URLSearchParams){
  if(!BIRDEYE_KEY)throw new Error("BIRDEYE_API_KEY missing");
  const wait=Math.max(0,nextAt-Date.now());if(wait)await sleep(wait);nextAt=Math.max(nextAt,Date.now())+MIN_INTERVAL_MS;
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),TIMEOUT_MS);
  try{const r=await fetch(`https://public-api.birdeye.so${pathname}?${q}`,{headers:{"X-API-KEY":BIRDEYE_KEY,"x-chain":"solana"},signal:c.signal});const text=await r.text();if(!r.ok)throw new Error(`${r.status}:${text.slice(0,180)}`);return text?JSON.parse(text):null;}finally{clearTimeout(timer);}
}

function arrayPayload(body:any):any[]{
  for(const x of [body?.data?.items,body?.data?.tokens,body?.data?.list,body?.data,body?.items,body?.tokens])if(Array.isArray(x))return x;
  return [];
}
function tokenMetric(row:any,names:string[]){for(const k of names){const n=finite(row?.[k]);if(n!==null)return n;}return null;}
function tokenLead(row:any,cohort:Cohort):TokenLead|null{
  const mint=pk(row?.address??row?.mint??row?.tokenAddress??row?.token_address);if(!mint)return null;
  const liquidity=tokenMetric(row,["liquidity","liquidity_usd","liquidityUsd"]),marketCap=tokenMetric(row,["market_cap","marketCap","mc","fdv"]),volume24h=tokenMetric(row,["volume_24h_usd","volume24hUSD","volume24hUsd","v24hUSD"]),priceChange24h=tokenMetric(row,["price_change_24h_percent","priceChange24hPercent","price_change_24h","price24hChangePercent"]),recentListingTime=tokenMetric(row,["recent_listing_time","recentListingTime","listing_time"]);
  const liqScore=Math.min(4,Math.max(0,(liquidity||0)/100000)),volScore=Math.min(4,Math.max(0,(volume24h||0)/250000)),moveScore=Math.min(6,Math.max(0,(priceChange24h||0)/50));
  return{mint,cohort,symbol:row?.symbol?String(row.symbol):null,liquidity,marketCap,volume24h,priceChange24h,recentListingTime,score:liqScore+volScore+moveScore};
}

async function cohortTokens(cohort:Cohort){
  const q=new URLSearchParams({sort_by:"volume_24h_usd",sort_type:"desc",offset:"0",limit:String(TOKENS_PER_COHORT),ui_amount_mode:"scaled"});
  if(cohort==="BREAKOUT_24H"){q.set("min_liquidity","25000");q.set("min_volume_24h_usd","100000");q.set("min_trade_24h_count","150");q.set("min_price_change_24h_percent","35");}
  else if(cohort==="FRESH_TRACTION"){q.set("min_liquidity","20000");q.set("min_volume_24h_usd","75000");q.set("min_trade_24h_count","100");q.set("min_price_change_4h_percent","10");q.set("min_recent_listing_time",String(Math.floor(Date.now()/1000)-72*3600));}
  else{q.set("min_liquidity","75000");q.set("min_volume_24h_usd","250000");q.set("min_market_cap","250000");q.set("min_trade_24h_count","300");}
  const body=await bird("/defi/v3/token/list",q);return arrayPayload(body).map(r=>tokenLead(r,cohort)).filter((x):x is TokenLead=>Boolean(x));
}

function walletOf(row:any){for(const k of ["wallet","owner","wallet_address","walletAddress","trader","address"]){const a=pk(row?.[k]);if(a)return a;}return null;}
async function traders(mint:string){const q=new URLSearchParams({address:mint,time_frame:"30d",sort_type:"desc",sort_by:"realized_pnl",offset:"0",limit:String(TRADERS_PER_TOKEN),min_trade:"2"});return arrayPayload(await bird("/defi/v2/tokens/top_traders",q));}
function pnlOf(row:any){for(const k of ["realizedPnl","realized_pnl","realizedProfit","realized_profit"]){const n=finite(row?.[k]);if(n!==null)return n;}return 0;}

function discoveryScore(w:WalletLead){
  const independentTokens=w.tokens.size,cohortCount=w.cohorts.size;
  const pnlSignal=Math.min(25,Math.log10(Math.max(1,w.realizedPnl+1))*6);
  return Math.round(independentTokens*20+Math.max(0,independentTokens-1)*20+cohortCount*12+Math.min(20,w.hits*2)+pnlSignal);
}
function upsert(state:AnyObj,w:WalletLead){
  const t=now(),old=state.wallets?.[w.address],tokens=[...w.tokens],cohorts=[...w.cohorts],score=discoveryScore(w),evidence=w.tokenEvidence.sort((a,b)=>b.score-a.score).slice(0,12).map(x=>({mint:x.mint,cohort:x.cohort,symbol:x.symbol,liquidity:x.liquidity,marketCap:x.marketCap,volume24h:x.volume24h,priceChange24h:x.priceChange24h}));
  const d={score,hits:w.hits,tokenCount:w.tokens.size,cohortCount:w.cohorts.size,cohorts,realizedPnlObserved:w.realizedPnl,positivePnlRows:w.positivePnlRows,providerRows:w.providerRows,evidence,updatedAt:t};
  if(!old){state.wallets[w.address]={address:w.address,firstSeen:t,lastSeen:t,rediscoveryCount:Math.max(1,w.hits),tokens,providers:["birdeye"],lanes:uniq(["OUTCOME_MINER","TOKEN_WINNER",...(tokens.length>=2?["CROSS_TOKEN_OUTCOME"]:[])]),tags:[],status:"RAW",discovery:{outcomeMiner:d}};return true;}
  old.lastSeen=t;old.rediscoveryCount=(old.rediscoveryCount||0)+Math.max(1,w.hits);old.tokens=uniq([...(old.tokens||[]),...tokens]);old.providers=uniq([...(old.providers||[]),"birdeye"]);old.lanes=uniq([...(old.lanes||[]),"OUTCOME_MINER",...(old.tokens.length>=2?["CROSS_TOKEN_OUTCOME"]:[])]);old.discovery={...(old.discovery||{}),outcomeMiner:d};return false;
}

export async function runOutcomeMiner(state?:AnyObj){
  const startedAt=now(),out=await json(OUT_PATH,{runs:[]}),last=Array.isArray(out?.runs)&&out.runs.length?out.runs[out.runs.length-1]:null,lastAt=Date.parse(String(last?.finishedAt||""));
  if(Number.isFinite(lastAt)&&Date.now()-lastAt<POLL_HOURS*3600_000)return{event:"shark_scout_outcome_miner_skipped",startedAt,reason:"not_due",pollHours:POLL_HOURS,nextDueInMinutes:Math.max(0,Math.ceil((POLL_HOURS*3600_000-(Date.now()-lastAt))/60000))};
  const s=state||await json(STATE_PATH,{schemaVersion:6,createdAt:startedAt,updatedAt:startedAt,wallets:{},tokens:{},runs:[]});s.wallets=s.wallets||{};s.tokens=s.tokens||{};
  if(!BIRDEYE_KEY)return{event:"shark_scout_outcome_miner_skipped",startedAt,reason:"BIRDEYE_API_KEY_missing"};
  const errors:string[]=[],tokenMap=new Map<string,TokenLead>();
  for(const cohort of ["BREAKOUT_24H","FRESH_TRACTION","LIQUID_ACTIVE"] as Cohort[]){try{for(const x of await cohortTokens(cohort)){const old=tokenMap.get(x.mint);if(!old||x.score>old.score)tokenMap.set(x.mint,x);}}catch(e){errors.push(`cohort:${cohort}:${String(e)}`);}}
  const candidates=[...tokenMap.values()].sort((a,b)=>b.score-a.score).slice(0,MAX_TOKEN_CALLS),wallets=new Map<string,WalletLead>();let traderCalls=0,rawWalletRows=0;
  for(const token of candidates){try{const rows=await traders(token.mint);traderCalls++;for(const row of rows){const a=walletOf(row);if(!a)continue;rawWalletRows++;let w=wallets.get(a);if(!w){w={address:a,tokens:new Set(),cohorts:new Set(),hits:0,realizedPnl:0,positivePnlRows:0,providerRows:0,tokenEvidence:[]};wallets.set(a,w);}w.tokens.add(token.mint);w.cohorts.add(token.cohort);w.hits++;w.providerRows++;const pnl=pnlOf(row);w.realizedPnl+=pnl;if(pnl>0)w.positivePnlRows++;w.tokenEvidence.push(token);}}catch(e){errors.push(`traders:${token.mint}:${String(e)}`);}}
  let newWallets=0;for(const w of wallets.values())if(upsert(s,w))newWallets++;
  for(const token of candidates){const t=now(),old=s.tokens[token.mint];s.tokens[token.mint]=old?{...old,lastSeen:t,providers:uniq([...(old.providers||[]),"birdeye:outcome"]),hits:(old.hits||0)+1,cohorts:uniq([...(old.cohorts||[]),token.cohort])}:{firstSeen:t,lastSeen:t,providers:["birdeye:outcome"],hits:1,cohorts:[token.cohort]};}
  s.updatedAt=now();if(!state)await atomic(STATE_PATH,s);
  const ranked=[...wallets.values()].map(w=>({address:w.address,score:discoveryScore(w),tokenCount:w.tokens.size,cohortCount:w.cohorts.size,hits:w.hits,cohorts:[...w.cohorts]})).sort((a,b)=>b.score-a.score).slice(0,25);
  const report={schemaVersion:1,event:"shark_scout_outcome_miner_complete",startedAt,finishedAt:now(),pollHours:POLL_HOURS,cohortTokenCount:tokenMap.size,tokensInvestigated:candidates.length,traderCalls,rawWalletRows,uniqueWallets:wallets.size,newWallets,crossTokenWallets:[...wallets.values()].filter(w=>w.tokens.size>=2).length,multiCohortWallets:[...wallets.values()].filter(w=>w.cohorts.size>=2).length,top:ranked,errors};
  out.runs=[...(Array.isArray(out?.runs)?out.runs.slice(-59):[]),report];out.last=report;await atomic(OUT_PATH,out);return report;
}

if(import.meta.url===`file://${process.argv[1]}`)runOutcomeMiner().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(JSON.stringify({event:"shark_scout_outcome_miner_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
