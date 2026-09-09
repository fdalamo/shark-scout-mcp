import { promises as fs } from "node:fs";
import path from "node:path";
import { providerFabricEnabled, providerFabricReport } from "./provider_fabric.js";
import { fetchNormalizedHistory, flushTransactionFabricCache, transactionFabricRuntimeStats } from "./transaction_fabric.js";

const STATE_PATH=process.env.CANONICAL_HISTORY_FABRIC_STATE_PATH||"/data/canonical-history-fabric.json";
const AMBIGUITY_PATH=process.env.CANONICAL_AMBIGUITY_QUEUE_PATH||"/data/canonical-ambiguity-queue.json";
const MAX_SCAN_PAGES=Math.max(1,Math.min(12,Number(process.env.CANONICAL_HISTORY_MAX_SCAN_PAGES||4)));
const RAW_PAGE_LIMIT=Math.max(40,Math.min(250,Number(process.env.CANONICAL_HISTORY_RAW_PAGE_LIMIT||100)));
const MAX_PROVIDER_CALLS=Math.max(100,Math.min(10000,Number(process.env.CANONICAL_HISTORY_MAX_PROVIDER_CALLS_PER_PROCESS||1800)));
const MAX_TX_PER_REQUEST=Math.max(20,Math.min(1000,Number(process.env.CANONICAL_HISTORY_MAX_TX_PER_REQUEST||220)));
const ENHANCED_FALLBACK=String(process.env.CANONICAL_HELIUS_ENHANCED_FALLBACK||"false").toLowerCase()==="true";
const MAX_FALLBACKS=Math.max(0,Math.min(4,Number(process.env.CANONICAL_HELIUS_ENHANCED_MAX_FALLBACKS||1)));

type Scope="gauntlet"|"deep_dive"|string;
type Stats={scope:Scope;requests:number;intercepted:number;fallbacks:number;rowsServed:number;swapRowsServed:number;providerCalls:number;cacheHits:number;transactionsConsidered:number;partialResponses:number;budgetStops:number;ambiguitiesQueued:number;startedAt:string};

function now(){return new Date().toISOString();}
async function json(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}

async function queueAmbiguities(address:string,rows:any[],scope:Scope,stats:Stats){
  const ambiguous=rows.filter(x=>x?.type!=="SWAP"&&Array.isArray(x?._normalized?.tokenDeltas)&&x._normalized.tokenDeltas.length>0&&Math.abs(Number(x?._normalized?.nativeSolDelta||0))>1e-9&&x?.signature);
  if(!ambiguous.length)return;
  const state=await json(AMBIGUITY_PATH,{schemaVersion:1,updatedAt:now(),entries:{}}),entries=state.entries||{};
  for(const row of ambiguous){const sig=String(row.signature),old=entries[sig]||{};entries[sig]={signature:sig,address,scope,firstSeenAt:old.firstSeenAt||now(),lastSeenAt:now(),seenCount:Number(old.seenCount||0)+1,reason:"token_and_native_delta_not_confidently_classified_as_swap",slot:Number(row?.slot||0)||null};stats.ambiguitiesQueued++;}
  const trimmed=Object.fromEntries(Object.entries(entries).sort((a:any,b:any)=>Date.parse(String(b[1]?.lastSeenAt||""))-Date.parse(String(a[1]?.lastSeenAt||""))).slice(0,5000));
  await atomic(AMBIGUITY_PATH,{schemaVersion:1,updatedAt:now(),entries:trimmed});
}

async function persistStats(stats:Stats){
  const prev=await json(STATE_PATH,{schemaVersion:1,runs:[],totals:{}}),t=prev.totals||{};
  const totals={requests:Number(t.requests||0)+stats.requests,intercepted:Number(t.intercepted||0)+stats.intercepted,fallbacks:Number(t.fallbacks||0)+stats.fallbacks,rowsServed:Number(t.rowsServed||0)+stats.rowsServed,swapRowsServed:Number(t.swapRowsServed||0)+stats.swapRowsServed,providerCalls:Number(t.providerCalls||0)+stats.providerCalls,cacheHits:Number(t.cacheHits||0)+stats.cacheHits,transactionsConsidered:Number(t.transactionsConsidered||0)+stats.transactionsConsidered,partialResponses:Number(t.partialResponses||0)+stats.partialResponses,budgetStops:Number(t.budgetStops||0)+stats.budgetStops,ambiguitiesQueued:Number(t.ambiguitiesQueued||0)+stats.ambiguitiesQueued};
  await atomic(STATE_PATH,{schemaVersion:1,updatedAt:now(),policy:{providerNeutral:true,heliusEnhancedFallback:ENHANCED_FALLBACK,maxFallbacks:MAX_FALLBACKS,maxScanPages:MAX_SCAN_PAGES,rawPageLimit:RAW_PAGE_LIMIT,maxProviderCallsPerProcess:MAX_PROVIDER_CALLS,maxTransactionsPerRequest:MAX_TX_PER_REQUEST,ambiguityQueue:AMBIGUITY_PATH},totals,runs:[...(Array.isArray(prev.runs)?prev.runs.slice(-119):[]),{...stats,finishedAt:now(),transactionFabric:transactionFabricRuntimeStats()}]});
}

export function installCanonicalHistoryFabric(scope:Scope){
  const original=globalThis.fetch.bind(globalThis);let providerRemaining=MAX_PROVIDER_CALLS,fallbackRemaining=MAX_FALLBACKS;
  const stats:Stats={scope,requests:0,intercepted:0,fallbacks:0,rowsServed:0,swapRowsServed:0,providerCalls:0,cacheHits:0,transactionsConsidered:0,partialResponses:0,budgetStops:0,ambiguitiesQueued:0,startedAt:now()};
  globalThis.fetch=(async(input:any,init?:RequestInit)=>{
    let u:URL;try{u=new URL(typeof input==="string"?input:input?.url);}catch{return original(input,init);}
    const match=u.hostname==="api.helius.xyz"&&/^\/v0\/addresses\/[^/]+\/transactions$/.test(u.pathname);
    if(!match||!providerFabricEnabled())return original(input,init);
    stats.requests++;
    const address=decodeURIComponent(u.pathname.split("/")[3]||""),desired=Math.max(1,Math.min(100,Number(u.searchParams.get("limit")||100))),swapOnly=(u.searchParams.get("type")||"").toUpperCase()==="SWAP",initialBefore=u.searchParams.get("before")||undefined;
    try{
      let before=initialBefore,scanPages=0,historyExhausted=false,budgetExhausted=false;const served:any[]=[],allScanned:any[]=[];
      while(served.length<desired&&scanPages<MAX_SCAN_PAGES&&!historyExhausted&&!budgetExhausted&&providerRemaining>0){
        const got=await fetchNormalizedHistory({address,beforeSignature:before,pageLimit:RAW_PAGE_LIMIT,maxPages:1,maxProviderCalls:providerRemaining,maxTransactions:MAX_TX_PER_REQUEST});
        scanPages++;providerRemaining=Math.max(0,providerRemaining-got.providerCalls);stats.providerCalls+=got.providerCalls;stats.cacheHits+=got.cacheHits;stats.transactionsConsidered+=got.transactionsConsidered;allScanned.push(...got.rows);const eligible=swapOnly?got.rows.filter((x:any)=>x?.type==="SWAP"):got.rows;for(const row of eligible){if(served.length>=desired)break;served.push(row);}before=got.lastScannedSignature||before;historyExhausted=Boolean(got.historyExhausted);budgetExhausted=Boolean(got.budgetExhausted)||providerRemaining<=0;if(got.truncated&&!got.lastScannedSignature)break;
      }
      await queueAmbiguities(address,allScanned,scope,stats);
      stats.intercepted++;stats.rowsServed+=served.length;stats.swapRowsServed+=served.filter((x:any)=>x?.type==="SWAP").length;if(served.length<desired&&!historyExhausted){stats.partialResponses++;if(budgetExhausted)stats.budgetStops++;}
      return new Response(JSON.stringify(served),{status:200,headers:{"content-type":"application/json","x-shark-provider-fabric":"canonical-history-raw","x-shark-partial":served.length<desired&&!historyExhausted?"true":"false"}});
    }catch(e){
      if(ENHANCED_FALLBACK&&fallbackRemaining>0){fallbackRemaining--;stats.fallbacks++;console.error(JSON.stringify({event:"shark_scout_canonical_history_fallback",scope,address,error:String(e).slice(0,300)}));return original(input,init);}
      console.error(JSON.stringify({event:"shark_scout_canonical_history_offload_error",scope,address,error:String(e).slice(0,300)}));return new Response(JSON.stringify([]),{status:200,headers:{"content-type":"application/json","x-shark-provider-fabric":"canonical-history-error-empty","x-shark-partial":"true"}});
    }
  }) as typeof fetch;
  return{stats,async close(){globalThis.fetch=original as typeof fetch;await flushTransactionFabricCache();await persistStats(stats);console.log(JSON.stringify({event:"shark_scout_canonical_history_fabric",...stats,providerRemaining,transactionFabric:transactionFabricRuntimeStats()}));console.log(JSON.stringify(await providerFabricReport()));}};
}

export async function runWithCanonicalHistoryFabric<T>(scope:Scope,fn:()=>Promise<T>){const fabric=installCanonicalHistoryFabric(scope);try{return await fn();}finally{await fabric.close();}}
