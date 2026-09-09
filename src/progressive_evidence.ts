import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchNormalizedHistory, flushTransactionFabricCache } from "./transaction_fabric.js";
import { providerFabricEnabled } from "./provider_fabric.js";

const EVIDENCE_DIR=process.env.CANONICAL_PROGRESSIVE_EVIDENCE_DIR||"/data/canonical-evidence";
const STATE_PATH=process.env.CANONICAL_PROGRESSIVE_EVIDENCE_STATE_PATH||"/data/progressive-evidence-state.json";
const MAX_WALLETS=Math.max(1,Math.min(16,Number(process.env.CANONICAL_PROGRESSIVE_MAX_WALLETS||8)));
const MAX_PROVIDER_CALLS=Math.max(20,Math.min(800,Number(process.env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS||240)));
const MAX_PROVIDER_CALLS_PER_WALLET=Math.max(8,Math.min(120,Number(process.env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET||40)));
const MAX_TX_PER_WALLET=Math.max(4,Math.min(120,Number(process.env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET||32)));
const PAGE_LIMIT=Math.max(20,Math.min(250,Number(process.env.CANONICAL_PROGRESSIVE_PAGE_LIMIT||100)));
const MAX_ROWS_PER_WALLET=Math.max(100,Math.min(5000,Number(process.env.CANONICAL_PROGRESSIVE_MAX_ROWS_PER_WALLET||1200)));

export type ProgressiveCandidate={address:string;priorityTier:number;deficit:number;closed:number;canonicalTrades?:number};
export type ProgressiveWalletState={schemaVersion:1;address:string;updatedAt:string;cursor:string|null;historyComplete:boolean;rows:any[];lastProgressAt?:string|null;zeroProgressReason?:string|null;scanCount:number};

type WalletRun={address:string;priorityTier:number;deficit:number;beforeSignature:string|null;afterSignature:string|null;providerCalls:number;transactionsConsidered:number;cacheHits:number;rowsFetched:number;rowsAdded:number;rowsTotal:number;historyComplete:boolean;budgetExhausted:boolean;zeroProgressReason:string|null};

function now(){return new Date().toISOString();}
async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function evidencePath(address:string){return path.join(EVIDENCE_DIR,`${address}.json`);}
function rowKey(x:any){return String(x?.signature||`${x?.timestamp||0}|${x?.slot||0}|${x?.type||"UNKNOWN"}`);}
function mergeRows(existing:any[],fresh:any[]){const m=new Map<string,any>();for(const x of existing||[])if(x)m.set(rowKey(x),x);for(const x of fresh||[])if(x)m.set(rowKey(x),x);return [...m.values()].sort((a,b)=>Number(b?.timestamp||0)-Number(a?.timestamp||0)).slice(0,MAX_ROWS_PER_WALLET);}

export async function readProgressiveEvidence(address:string):Promise<ProgressiveWalletState>{
  const x=await readJson(evidencePath(address),null);
  if(x?.schemaVersion===1&&Array.isArray(x?.rows))return{schemaVersion:1,address,updatedAt:String(x.updatedAt||now()),cursor:x.cursor?String(x.cursor):null,historyComplete:Boolean(x.historyComplete),rows:x.rows,lastProgressAt:x.lastProgressAt||null,zeroProgressReason:x.zeroProgressReason||null,scanCount:Number(x.scanCount||0)};
  return{schemaVersion:1,address,updatedAt:now(),cursor:null,historyComplete:false,rows:[],lastProgressAt:null,zeroProgressReason:null,scanCount:0};
}

function rank(a:ProgressiveCandidate,b:ProgressiveCandidate){if(b.priorityTier!==a.priorityTier)return b.priorityTier-a.priorityTier;if(b.deficit!==a.deficit)return b.deficit-a.deficit;return b.closed-a.closed;}
function reasonFor(got:any,added:number,providerEnabled:boolean){if(!providerEnabled)return "PROVIDER_FABRIC_DISABLED";if(got?.budgetExhausted)return "PROVIDER_BUDGET_EXHAUSTED";if(got?.historyExhausted&&!got?.lastScannedSignature)return "NO_SIGNATURE_HISTORY";if(Number(got?.transactionsConsidered||0)===0&&got?.lastScannedSignature)return "SIGNATURES_SCANNED_NO_TX_BUDGET";if(Number(got?.rows?.length||0)===0&&Number(got?.transactionsConsidered||0)>0)return "NO_NORMALIZED_TRANSACTION_ROWS";if(added===0&&Number(got?.rows?.length||0)>0)return "ROWS_ALREADY_PRESENT";return null;}

export async function hydrateProgressiveEvidence(candidates:ProgressiveCandidate[]){
  const startedAt=now(),enabled=providerFabricEnabled();
  const selected=[...candidates].filter(x=>x?.address&&x.deficit>0).sort(rank).slice(0,MAX_WALLETS);
  let remaining=MAX_PROVIDER_CALLS,totalCalls=0,totalRowsFetched=0,totalRowsAdded=0,totalCacheHits=0,totalTransactions=0;
  const wallets:WalletRun[]=[];
  for(const c of selected){
    const prior=await readProgressiveEvidence(c.address),before=prior.historyComplete?null:prior.cursor;
    if(prior.historyComplete){wallets.push({address:c.address,priorityTier:c.priorityTier,deficit:c.deficit,beforeSignature:before,afterSignature:before,providerCalls:0,transactionsConsidered:0,cacheHits:0,rowsFetched:0,rowsAdded:0,rowsTotal:prior.rows.length,historyComplete:true,budgetExhausted:false,zeroProgressReason:"HISTORY_ALREADY_COMPLETE"});continue;}
    if(!enabled||remaining<=0){const zeroProgressReason=!enabled?"PROVIDER_FABRIC_DISABLED":"RUN_PROVIDER_BUDGET_EXHAUSTED";prior.updatedAt=now();prior.zeroProgressReason=zeroProgressReason;prior.scanCount++;await atomic(evidencePath(c.address),prior);wallets.push({address:c.address,priorityTier:c.priorityTier,deficit:c.deficit,beforeSignature:before,afterSignature:before,providerCalls:0,transactionsConsidered:0,cacheHits:0,rowsFetched:0,rowsAdded:0,rowsTotal:prior.rows.length,historyComplete:false,budgetExhausted:remaining<=0,zeroProgressReason});continue;}
    const walletBudget=Math.min(remaining,MAX_PROVIDER_CALLS_PER_WALLET);
    try{
      const got=await fetchNormalizedHistory({address:c.address,beforeSignature:before||undefined,pageLimit:PAGE_LIMIT,maxPages:1,maxProviderCalls:walletBudget,maxTransactions:MAX_TX_PER_WALLET});
      remaining=Math.max(0,remaining-Number(got.providerCalls||0));totalCalls+=Number(got.providerCalls||0);totalRowsFetched+=got.rows.length;totalCacheHits+=Number(got.cacheHits||0);totalTransactions+=Number(got.transactionsConsidered||0);
      const merged=mergeRows(prior.rows,got.rows),added=Math.max(0,merged.length-prior.rows.length),cursor=got.historyExhausted?prior.cursor:(got.lastScannedSignature||prior.cursor);
      totalRowsAdded+=added;const zeroProgressReason=reasonFor(got,added,enabled);
      const next:ProgressiveWalletState={schemaVersion:1,address:c.address,updatedAt:now(),cursor:cursor||null,historyComplete:Boolean(prior.historyComplete||got.historyExhausted),rows:merged,lastProgressAt:added>0?now():prior.lastProgressAt||null,zeroProgressReason,scanCount:prior.scanCount+1};
      await atomic(evidencePath(c.address),next);
      wallets.push({address:c.address,priorityTier:c.priorityTier,deficit:c.deficit,beforeSignature:before,afterSignature:next.cursor,providerCalls:Number(got.providerCalls||0),transactionsConsidered:Number(got.transactionsConsidered||0),cacheHits:Number(got.cacheHits||0),rowsFetched:got.rows.length,rowsAdded:added,rowsTotal:merged.length,historyComplete:next.historyComplete,budgetExhausted:Boolean(got.budgetExhausted),zeroProgressReason});
    }catch(e){
      const zeroProgressReason=`PROGRESSIVE_FETCH_FAILED:${e instanceof Error?e.message:String(e)}`.slice(0,240);prior.updatedAt=now();prior.zeroProgressReason=zeroProgressReason;prior.scanCount++;await atomic(evidencePath(c.address),prior);wallets.push({address:c.address,priorityTier:c.priorityTier,deficit:c.deficit,beforeSignature:before,afterSignature:before,providerCalls:0,transactionsConsidered:0,cacheHits:0,rowsFetched:0,rowsAdded:0,rowsTotal:prior.rows.length,historyComplete:prior.historyComplete,budgetExhausted:false,zeroProgressReason});
    }
  }
  await flushTransactionFabricCache();
  const out={schemaVersion:1,event:"shark_scout_progressive_evidence_complete",startedAt,finishedAt:now(),policy:{mode:"G0_SIGNATURE_CENSUS_PLUS_G1_BOUNDED_TX_SAMPLE",providerNeutral:true,liveAndExplicitPriorityFirst:true,noOdinMutation:true,noNewProviderDependency:true,maxWallets:MAX_WALLETS,maxProviderCalls:MAX_PROVIDER_CALLS,maxProviderCallsPerWallet:MAX_PROVIDER_CALLS_PER_WALLET,maxTransactionsPerWallet:MAX_TX_PER_WALLET,pageLimit:PAGE_LIMIT},selectedWallets:selected.length,totalProviderCalls:totalCalls,remainingProviderCalls:remaining,totalTransactionsConsidered:totalTransactions,totalCacheHits,totalRowsFetched,totalRowsAdded,progressWallets:wallets.filter(x=>x.rowsAdded>0).length,zeroProgressWallets:wallets.filter(x=>x.rowsAdded===0).length,wallets};
  await atomic(STATE_PATH,out);console.log(JSON.stringify(out));return out;
}
