import { promises as fs } from "node:fs";
import path from "node:path";
import { routedRpc, providerFabricEnabled } from "./provider_fabric.js";

const CACHE_PATH=process.env.TRANSACTION_FABRIC_CACHE_PATH||"/data/transaction-fabric-cache.json";
const MAX_CACHE=Math.max(1000,Math.min(100000,Number(process.env.TRANSACTION_FABRIC_MAX_CACHE||50000)));
const FLUSH_EVERY=Math.max(1,Math.min(250,Number(process.env.TRANSACTION_FABRIC_FLUSH_EVERY||32)));
const WSOL="So11111111111111111111111111111111111111112";

type Cache={schemaVersion:2;updatedAt:string;transactions:Record<string,any>};
type HistoryOpts={address:string;stopSignature?:string|null;beforeSignature?:string|null;pageLimit?:number;maxPages?:number;maxProviderCalls?:number;maxTransactions?:number};

function now(){return new Date().toISOString();}
function keyOf(x:any){return typeof x==="string"?x:String(x?.pubkey||"");}
function amount(x:any){const ui=x?.uiTokenAmount;if(ui?.uiAmountString!=null)return Number(ui.uiAmountString);if(ui?.amount!=null&&ui?.decimals!=null)return Number(ui.amount)/10**Number(ui.decimals);return 0;}
function agg(list:any[],owner:string){const m=new Map<string,number>();for(const b of list||[]){if(String(b?.owner||"")!==owner)continue;const mint=String(b?.mint||"");if(mint)m.set(mint,(m.get(mint)||0)+amount(b));}return m;}
async function readCache():Promise<Cache>{try{const x=JSON.parse(await fs.readFile(CACHE_PATH,"utf8"));if((x?.schemaVersion===1||x?.schemaVersion===2)&&x?.transactions)return{schemaVersion:2,updatedAt:x.updatedAt||now(),transactions:x.transactions};}catch{}return{schemaVersion:2,updatedAt:now(),transactions:{}};}
let cachePromise:Promise<Cache>|null=null,dirty=0,flushPromise:Promise<void>|null=null;
async function cache(){cachePromise=cachePromise||readCache();return cachePromise;}
async function saveCache(c:Cache){const entries=Object.entries(c.transactions);if(entries.length>MAX_CACHE)c.transactions=Object.fromEntries(entries.slice(-MAX_CACHE));c.updatedAt=now();await fs.mkdir(path.dirname(CACHE_PATH),{recursive:true});const tmp=`${CACHE_PATH}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(c));await fs.rename(tmp,CACHE_PATH);}
export async function flushTransactionFabricCache(){if(flushPromise)return flushPromise;if(!dirty)return;flushPromise=(async()=>{const c=await cache();await saveCache(c);dirty=0;})().finally(()=>{flushPromise=null;});return flushPromise;}
async function markDirty(){dirty++;if(dirty>=FLUSH_EVERY)await flushTransactionFabricCache();}

const runtime={historyCalls:0,signatureCalls:0,transactionCalls:0,cacheHits:0,cacheMisses:0,nullCacheHits:0,rows:0,budgetStops:0};
export function transactionFabricRuntimeStats(){return{...runtime,dirtyCacheEntries:dirty,maxCache:MAX_CACHE,flushEvery:FLUSH_EVERY};}

export function normalizeRawTransaction(tx:any,address:string,signature:string){
  if(!tx?.meta||tx.meta.err)return null;
  const keys=tx?.transaction?.message?.accountKeys||[],walletIndex=keys.findIndex((k:any)=>keyOf(k)===address);
  const preLam=walletIndex>=0?Number(tx?.meta?.preBalances?.[walletIndex]||0):0,postLam=walletIndex>=0?Number(tx?.meta?.postBalances?.[walletIndex]||0):0;
  const feePayer=walletIndex===0,feeLam=feePayer?Number(tx?.meta?.fee||0):0,rawDelta=postLam-preLam;
  const nativeTradeLam=rawDelta<0?Math.min(0,rawDelta+feeLam):rawDelta>0?rawDelta+feeLam:0;
  const pre=agg(tx?.meta?.preTokenBalances||[],address),post=agg(tx?.meta?.postTokenBalances||[],address),mints=new Set([...pre.keys(),...post.keys()]);
  const deltas=[...mints].map(mint=>({mint,delta:(post.get(mint)||0)-(pre.get(mint)||0)})).filter(x=>Math.abs(x.delta)>1e-12);
  const tokenInputs=deltas.filter(x=>x.delta<0&&x.mint!==WSOL).map(x=>({userAccount:address,mint:x.mint,tokenAmount:Math.abs(x.delta)}));
  const tokenOutputs=deltas.filter(x=>x.delta>0&&x.mint!==WSOL).map(x=>({userAccount:address,mint:x.mint,tokenAmount:x.delta}));
  const wsol=deltas.find(x=>x.mint===WSOL)?.delta||0;
  const nativeInput=nativeTradeLam<0?{amount:Math.round(Math.abs(nativeTradeLam))}:wsol<0?{amount:Math.round(Math.abs(wsol)*1e9)}:undefined;
  const nativeOutput=nativeTradeLam>0?{amount:Math.round(nativeTradeLam)}:wsol>0?{amount:Math.round(wsol*1e9)}:undefined;
  const tokenTransfers=deltas.map(x=>x.delta>0?{mint:x.mint,toUserAccount:address,fromUserAccount:null,tokenAmount:x.delta}:{mint:x.mint,fromUserAccount:address,toUserAccount:null,tokenAmount:Math.abs(x.delta)});
  const nativeTransfers:any[]=[];if(nativeInput)nativeTransfers.push({fromUserAccount:address,toUserAccount:null,amount:nativeInput.amount});if(nativeOutput)nativeTransfers.push({fromUserAccount:null,toUserAccount:address,amount:nativeOutput.amount});
  const swapLike=(tokenInputs.length===1&&Boolean(nativeOutput))||(tokenOutputs.length===1&&Boolean(nativeInput));
  return{signature,timestamp:Number(tx?.blockTime||0),slot:Number(tx?.slot||0),fee:Number(tx?.meta?.fee||0),type:swapLike?"SWAP":"UNKNOWN",source:"provider_fabric_raw",events:{swap:{tokenInputs,tokenOutputs,nativeInput,nativeOutput}},tokenTransfers,nativeTransfers,_normalized:{address,tokenDeltas:deltas,nativeSolDelta:rawDelta/1e9,feeSol:feeLam/1e9}};
}

export async function fetchNormalizedTransaction(signature:string,address:string){
  const c=await cache(),entry=c.transactions[signature],byAddress=entry?.normalizedByAddress;
  if(byAddress&&Object.prototype.hasOwnProperty.call(byAddress,address)){runtime.cacheHits++;if(byAddress[address]===null)runtime.nullCacheHits++;return{row:byAddress[address],provider:"cache",cacheHit:true};}
  runtime.cacheMisses++;if(!providerFabricEnabled())throw new Error("transaction_fabric_provider_fabric_disabled");
  const r=await routedRpc("getTransaction",[signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:1}]);runtime.transactionCalls++;
  const row=normalizeRawTransaction(r.result,address,signature);c.transactions[signature]=c.transactions[signature]||{fetchedAt:now(),normalizedByAddress:{}};c.transactions[signature].normalizedByAddress=c.transactions[signature].normalizedByAddress||{};c.transactions[signature].normalizedByAddress[address]=row;c.transactions[signature].provider=r.provider;c.transactions[signature].fetchedAt=c.transactions[signature].fetchedAt||now();await markDirty();return{row,provider:r.provider,cacheHit:false};
}

export async function fetchNormalizedHistory(opts:HistoryOpts){
  runtime.historyCalls++;
  const pageLimit=Math.max(20,Math.min(1000,Math.floor(opts.pageLimit||100))),maxPages=Math.max(1,Math.min(24,Math.floor(opts.maxPages||3))),stop=opts.stopSignature?.trim()||null;
  const providerBudget=Math.max(1,Math.min(100000,Math.floor(opts.maxProviderCalls||100000))),txBudget=Math.max(1,Math.min(100000,Math.floor(opts.maxTransactions||100000)));
  const rows:any[]=[],seen=new Set<string>();let before=opts.beforeSignature?.trim()||undefined,newest:string|null=null,oldest:string|null=null,reachedStop=false,pagesFetched=0,truncated=false,providerCalls=0,cacheHits=0,transactionsConsidered=0,budgetExhausted=false,historyExhausted=false,lastScannedSignature:string|null=null;
  outer:for(let page=0;page<maxPages;page++){
    if(providerCalls>=providerBudget){budgetExhausted=true;runtime.budgetStops++;break;}
    const cfg:any={limit:Math.min(pageLimit,1000),commitment:"confirmed"};if(before)cfg.before=before;
    const pageRes=await routedRpc("getSignaturesForAddress",[opts.address,cfg]);providerCalls++;runtime.signatureCalls++;const sigRows=Array.isArray(pageRes.result)?pageRes.result:[];pagesFetched++;if(page===0)newest=String(sigRows[0]?.signature||"")||null;if(!sigRows.length){historyExhausted=true;break;}
    for(const s of sigRows){const sig=String(s?.signature||"");if(!sig)continue;lastScannedSignature=sig;if(stop&&sig===stop){reachedStop=true;break outer;}if(seen.has(sig))continue;seen.add(sig);if(transactionsConsidered>=txBudget){budgetExhausted=true;runtime.budgetStops++;break outer;}const c=await cache(),entry=c.transactions[sig],cached=Boolean(entry?.normalizedByAddress&&Object.prototype.hasOwnProperty.call(entry.normalizedByAddress,opts.address));if(!cached&&providerCalls>=providerBudget){budgetExhausted=true;runtime.budgetStops++;break outer;}const x=await fetchNormalizedTransaction(sig,opts.address);transactionsConsidered++;if(x.cacheHit)cacheHits++;else providerCalls++;if(x.row?.timestamp>0){rows.push(x.row);oldest=sig;runtime.rows++;}}
    if(sigRows.length<cfg.limit){historyExhausted=true;break;}const tail=String(sigRows[sigRows.length-1]?.signature||"");if(!tail||tail===before){historyExhausted=true;break;}before=tail;if(page===maxPages-1)truncated=true;
  }
  if(budgetExhausted||(!historyExhausted&&!reachedStop&&pagesFetched>=maxPages))truncated=true;
  return{rows,newestSignature:newest,oldestSignature:oldest,stopSignature:stop,beforeSignature:opts.beforeSignature||null,lastScannedSignature,reachedStop,pagesFetched,truncated,budgetExhausted,historyExhausted,providerCalls,cacheHits,transactionsConsidered,source:"provider_fabric_raw"};
}
