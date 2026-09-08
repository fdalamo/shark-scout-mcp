import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyEnhancedTransaction } from "./replay_core.js";
import { providerFabricEnabled, routedRpc } from "./provider_fabric.js";

const RAW_CACHE_DIR=process.env.CANONICAL_RESCUE_CACHE_DIR||"/data/canonical-rescue/raw";
const MAX_PER_WALLET=Math.max(0,Math.min(12,Number(process.env.CANONICAL_RESCUE_MAX_PER_WALLET||4)));
const ESCALATABLE=new Set(["NO_NONQUOTE_DELTA","NO_QUOTE_DELTA","MULTIPLE_QUOTE_DELTAS","MULTIPLE_NONQUOTE_DELTAS","TOKEN_TO_TOKEN_NO_EXACT_QUOTE"]);

type Budget={remaining:number;attempted:number;cacheHits:number;resolved:number;failed:number;providers:Record<string,number>;reasons:Record<string,number>};
export type RescueStats={wallet:string;candidates:number;attempted:number;cacheHits:number;fetched:number;resolved:number;failed:number;reasonCodes:Record<string,number>};

function inc(o:Record<string,number>,k:string){o[k]=(o[k]||0)+1;}
function num(v:any):number|null{const x=Number(v);return Number.isFinite(x)?x:null;}
function uiAmount(x:any):number|null{const u=x?.uiTokenAmount;if(u?.uiAmountString!=null){const n=Number(u.uiAmountString);if(Number.isFinite(n))return n;}if(u?.uiAmount!=null){const n=Number(u.uiAmount);if(Number.isFinite(n))return n;}const raw=u?.amount,dec=Number(u?.decimals);if(raw!=null&&Number.isFinite(dec)){const n=Number(raw)/10**dec;return Number.isFinite(n)?n:null;}return null;}
function keyString(x:any){return typeof x==="string"?x:String(x?.pubkey||x?.key||"");}
async function readJson(file:string){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return null;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function cachePath(signature:string){return path.join(RAW_CACHE_DIR,`${signature}.json`);}

function rawEnvelope(raw:any){return raw?.result||raw;}
function granularReason(raw:any,wallet:string){const r=rawEnvelope(raw),meta=r?.meta,msg=r?.transaction?.message;if(!meta||!msg)return "MISSING_RAW_META";const pre=Array.isArray(meta.preTokenBalances)?meta.preTokenBalances:[],post=Array.isArray(meta.postTokenBalances)?meta.postTokenBalances:[],owned=[...pre,...post].filter((x:any)=>x?.owner===wallet);const inner=Array.isArray(meta.innerInstructions)&&meta.innerInstructions.length>0;if(!owned.length){const keys=Array.isArray(msg.accountKeys)?msg.accountKeys.map(keyString):[];if(!keys.includes(wallet))return "WALLET_NOT_RESOLVED_IN_RAW_META";return inner?"CPI_TOKEN_OWNER_UNRESOLVED":"TOKEN_OWNER_UNRESOLVED";}const nonQuote=owned.filter((x:any)=>{const m=String(x?.mint||"");return m&&m!=="So11111111111111111111111111111111111111112"&&m!=="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"&&m!=="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";});if(!nonQuote.length)return inner?"CPI_QUOTE_ONLY_OR_WSOL_TEMP_ACCOUNT":"QUOTE_ONLY_OR_WSOL_TEMP_ACCOUNT";return inner?"CPI_NO_MATERIAL_WALLET_DELTA":"RAW_META_NO_MATERIAL_WALLET_DELTA";}

export function augmentWithRawMeta(tx:any,raw:any,wallet:string){const r=rawEnvelope(raw),meta=r?.meta,msg=r?.transaction?.message;if(!meta||!msg)return{...tx,_canonicalRescueReason:"MISSING_RAW_META"};const keys=Array.isArray(msg.accountKeys)?msg.accountKeys.map(keyString):[],preTok=Array.isArray(meta.preTokenBalances)?meta.preTokenBalances:[],postTok=Array.isArray(meta.postTokenBalances)?meta.postTokenBalances:[];
  const byIndex=new Map<number,{mint:string;owner:string;pre:number;post:number}>();
  for(const x of preTok){const i=Number(x?.accountIndex);if(!Number.isInteger(i)||!x?.mint)continue;const a=byIndex.get(i)||{mint:String(x.mint),owner:String(x?.owner||""),pre:0,post:0};a.mint=String(x.mint);if(x?.owner)a.owner=String(x.owner);a.pre=uiAmount(x)||0;byIndex.set(i,a);}
  for(const x of postTok){const i=Number(x?.accountIndex);if(!Number.isInteger(i)||!x?.mint)continue;const a=byIndex.get(i)||{mint:String(x.mint),owner:String(x?.owner||""),pre:0,post:0};a.mint=String(x.mint);if(x?.owner)a.owner=String(x.owner);a.post=uiAmount(x)||0;byIndex.set(i,a);}
  const tokenBalanceChanges:any[]=[];for(const a of byIndex.values()){if(a.owner!==wallet)continue;const delta=a.post-a.pre;if(Math.abs(delta)<1e-18)continue;tokenBalanceChanges.push({userAccount:wallet,mint:a.mint,tokenAmount:delta});}
  const wi=keys.indexOf(wallet),preBal=wi>=0?num(meta?.preBalances?.[wi]):null,postBal=wi>=0?num(meta?.postBalances?.[wi]):null,nativeBalanceChange=preBal!=null&&postBal!=null?postBal-preBal:null;
  const synthetic={account:wallet,nativeBalanceChange,tokenBalanceChanges};const prior=Array.isArray(tx?.accountData)?tx.accountData:[];const keep=prior.filter((x:any)=>x?.account!==wallet);const reason=granularReason(r,wallet);
  return{...tx,accountData:[...keep,synthetic],feePayer:tx?.feePayer||keys[0]||tx?.fee_payer,fee:tx?.fee??meta?.fee,_canonicalRescueReason:reason,_canonicalRescuePass:"RAW_META_PREPOST_CPI",_canonicalRawBlockTime:r?.blockTime??null};
}

export function createRescueBudget(maxCalls?:number):Budget{const requested=maxCalls??Number(process.env.CANONICAL_RESCUE_MAX_CALLS||32);const cap=Math.max(0,Math.min(64,Number(requested)));return{remaining:cap,attempted:0,cacheHits:0,resolved:0,failed:0,providers:{},reasons:{}};}

export async function rescueRows(rows:any[],wallet:string,budget:Budget):Promise<{rows:any[];stats:RescueStats}> {const out=[...rows],stats:RescueStats={wallet,candidates:0,attempted:0,cacheHits:0,fetched:0,resolved:0,failed:0,reasonCodes:{}};let walletCalls=0;
  for(let i=0;i<out.length;i++){const tx=out[i],before=classifyEnhancedTransaction(tx,wallet);if(before.trade||!before.reason||!ESCALATABLE.has(before.reason))continue;stats.candidates++;if(!tx?.signature){inc(stats.reasonCodes,"MISSING_SIGNATURE");continue;}const sig=String(tx.signature);let raw=await readJson(cachePath(sig));if(raw){stats.cacheHits++;budget.cacheHits++;}else{if(walletCalls>=MAX_PER_WALLET||budget.remaining<=0||!providerFabricEnabled()){inc(stats.reasonCodes,budget.remaining<=0?"RESCUE_BUDGET_EXHAUSTED":!providerFabricEnabled()?"PROVIDER_FABRIC_DISABLED":"WALLET_RESCUE_CAP");continue;}walletCalls++;budget.remaining--;budget.attempted++;stats.attempted++;try{const got=await routedRpc("getTransaction",[sig,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}]);raw=got.result;inc(budget.providers,got.provider);stats.fetched++;if(raw)await atomic(cachePath(sig),raw);else inc(stats.reasonCodes,"RPC_TRANSACTION_NULL");}catch(e){stats.failed++;budget.failed++;inc(stats.reasonCodes,"RPC_ESCALATION_FAILED");continue;}}
    if(!raw)continue;const augmented=augmentWithRawMeta(tx,raw,wallet),after=classifyEnhancedTransaction(augmented,wallet);out[i]=augmented;if(after.trade){stats.resolved++;budget.resolved++;inc(stats.reasonCodes,"RESOLVED_RAW_META");}else{const reason=augmented?._canonicalRescueReason||after.reason||"UNRESOLVED_AFTER_RAW_META";inc(stats.reasonCodes,reason);inc(budget.reasons,reason);}
  }
  return{rows:out,stats};
}
