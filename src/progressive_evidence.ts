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
export type ProgressiveWalletState={schemaVersion:2;address:string;updatedAt:string;cursor:string|null;historyComplete:boolean;rows:any[];lastProgressAt?:string|null;zeroProgressReason?:string|null;scanCount:number;providerCallsTotal:number;rowsAddedTotal:number;zeroProgressStreak:number;lastProviderCalls:number;lastRowsAdded:number;informationYield:number};
type RankedCandidate=ProgressiveCandidate&{prior:ProgressiveWalletState;informationYield:number;zeroProgressStreak:number};
type WalletRun={address:string;priorityTier:number;deficit:number;beforeSignature:string|null;afterSignature:string|null;providerCalls:number;transactionsConsidered:number;cacheHits:number;rowsFetched:number;rowsAdded:number;rowsTotal:number;historyComplete:boolean;budgetExhausted:boolean;zeroProgressReason:string|null;informationYieldBefore:number;informationYieldAfter:number;zeroProgressStreak:number;walletBudget:number};

function now(){return new Date().toISOString();}
async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function evidencePath(address:string){return path.join(EVIDENCE_DIR,`${address}.json`);}
function rowKey(x:any){return String(x?.signature||`${x?.timestamp||0}|${x?.slot||0}|${x?.type||"UNKNOWN"}`);}
function mergeRows(existing:any[],fresh:any[]){const m=new Map<string,any>();for(const x of existing||[])if(x)m.set(rowKey(x),x);for(const x of fresh||[])if(x)m.set(rowKey(x),x);return [...m.values()].sort((a,b)=>Number(b?.timestamp||0)-Number(a?.timestamp||0)).slice(0,MAX_ROWS_PER_WALLET);}
function yieldOf(calls:number,rows:number){return calls>0?rows/calls:0;}

export async function readProgressiveEvidence(address:string):Promise<ProgressiveWalletState>{
  const x=await readJson(evidencePath(address),null);
  if((x?.schemaVersion===1||x?.schemaVersion===2)&&Array.isArray(x?.rows)){
    const calls=Math.max(0,Number(x.providerCallsTotal??x.lastProviderCalls??0)),rowsAdded=Math.max(0,Number(x.rowsAddedTotal??x.lastRowsAdded??0));
    return{schemaVersion:2,address,updatedAt:String(x.updatedAt||now()),cursor:x.cursor?String(x.cursor):null,historyComplete:Boolean(x.historyComplete),rows:x.rows,lastProgressAt:x.lastProgressAt||null,zeroProgressReason:x.zeroProgressReason||null,scanCount:Number(x.scanCount||0),providerCallsTotal:calls,rowsAddedTotal:rowsAdded,zeroProgressStreak:Math.max(0,Number(x.zeroProgressStreak??(x.zeroProgressReason?1:0))),lastProviderCalls:Math.max(0,Number(x.lastProviderCalls||0)),lastRowsAdded:Math.max(0,Number(x.lastRowsAdded||0)),informationYield:yieldOf(calls,rowsAdded)};
  }
  return{schemaVersion:2,address,updatedAt:now(),cursor:null,historyComplete:false,rows:[],lastProgressAt:null,zeroProgressReason:null,scanCount:0,providerCallsTotal:0,rowsAddedTotal:0,zeroProgressStreak:0,lastProviderCalls:0,lastRowsAdded:0,informationYield:0};
}

function rank(a:RankedCandidate,b:RankedCandidate){
  if(b.priorityTier!==a.priorityTier)return b.priorityTier-a.priorityTier;
  const ac=(a.canonicalTrades||0)>0,bc=(b.canonicalTrades||0)>0;if(ac!==bc)return Number(bc)-Number(ac);
  const ap=Math.max(0,a.zeroProgressStreak),bp=Math.max(0,b.zeroProgressStreak);if(ap!==bp)return ap-bp;
  if(a.informationYield!==b.informationYield)return b.informationYield-a.informationYield;
  if(a.deficit!==b.deficit)return a.deficit-b.deficit;
  if((b.canonicalTrades||0)!==(a.canonicalTrades||0))return (b.canonicalTrades||0)-(a.canonicalTrades||0);
  return b.closed-a.closed;
}
function reasonFor(got:any,added:number,providerEnabled:boolean){if(!providerEnabled)return "PROVIDER_FABRIC_DISABLED";if(got?.budgetExhausted)return "PROVIDER_BUDGET_EXHAUSTED";if(got?.historyExhausted&&!got?.lastScannedSignature)return "NO_SIGNATURE_HISTORY";if(Number(got?.transactionsConsidered||0)===0&&got?.lastScannedSignature)return "SIGNATURES_SCANNED_NO_TX_BUDGET";if(Number(got?.rows?.length||0)===0&&Number(got?.transactionsConsidered||0)>0)return "NO_NORMALIZED_TRANSACTION_ROWS";if(added===0&&Number(got?.rows?.length||0)>0)return "ROWS_ALREADY_PRESENT";return null;}
function adaptiveBudget(x:RankedCandidate,remaining:number){
  let desired=Math.min(MAX_PROVIDER_CALLS_PER_WALLET,remaining);
  if(x.priorityTier>=2)return desired;
  if(x.zeroProgressStreak>=3)desired=Math.min(desired,8);
  else if(x.zeroProgressStreak>=2)desired=Math.min(desired,12);
  else if(x.informationYield>=.50)desired=Math.min(desired,MAX_PROVIDER_CALLS_PER_WALLET);
  else if(x.informationYield>0&&x.informationYield<.10)desired=Math.min(desired,16);
  return Math.max(8,desired);
}

export async function hydrateProgressiveEvidence(candidates:ProgressiveCandidate[]){
  const startedAt=now(),enabled=providerFabricEnabled();
  const ranked:RankedCandidate[]=[];
  for(const c of candidates.filter(x=>x?.address&&x.deficit>0)){const prior=await readProgressiveEvidence(c.address);ranked.push({...c,prior,informationYield:prior.informationYield,zeroProgressStreak:prior.zeroProgressStreak});}
  const selected=ranked.sort(rank).slice(0,MAX_WALLETS);
  let remaining=MAX_PROVIDER_CALLS,totalCalls=0,totalRowsFetched=0,totalRowsAdded=0,totalCacheHits=0,totalTransactions=0;
  const wallets:WalletRun[]=[];
  for(const c of selected){
    const prior=c.prior,before=prior.historyComplete?null:prior.cursor,informationYieldBefore=prior.informationYield;
    if(prior.historyComplete){wallets.push({address:c.address,priorityTier:c.priorityTier,deficit:c.deficit,beforeSignature:before,afterSignature:before,providerCalls:0,transactionsConsidered:0,cacheHits:0,rowsFetched:0,rowsAdded:0,rowsTotal:prior.rows.length,historyComplete:true,budgetExhausted:false,zeroProgressReason:"HISTORY_ALREADY_COMPLETE",informationYieldBefore,informationYieldAfter:informationYieldBefore,zeroProgressStreak:prior.zeroProgressStreak,walletBudget:0});continue;}
    if(!enabled||remaining<=0){const zeroProgressReason=!enabled?"PROVIDER_FABRIC_DISABLED":"RUN_PROVIDER_BUDGET_EXHAUSTED";const next={...prior,updatedAt:now(),zeroProgressReason,scanCount:prior.scanCount+1};await atomic(evidencePath(c.address),next);wallets.push({address:c.address,priorityTier:c.priorityTier,deficit:c.deficit,beforeSignature:before,afterSignature:before,providerCalls:0,transactionsConsidered:0,cacheHits:0,rowsFetched:0,rowsAdded:0,rowsTotal:prior.rows.length,historyComplete:false,budgetExhausted:remaining<=0,zeroProgressReason,informationYieldBefore,informationYieldAfter:prior.informationYield,zeroProgressStreak:prior.zeroProgressStreak,walletBudget:0});continue;}
    const walletBudget=adaptiveBudget(c,remaining);
    try{
      const got=await fetchNormalizedHistory({address:c.address,beforeSignature:before||undefined,pageLimit:PAGE_LIMIT,maxPages:1,maxProviderCalls:walletBudget,maxTransactions:MAX_TX_PER_WALLET});
      const calls=Number(got.providerCalls||0);remaining=Math.max(0,remaining-calls);totalCalls+=calls;totalRowsFetched+=got.rows.length;totalCacheHits+=Number(got.cacheHits||0);totalTransactions+=Number(got.transactionsConsidered||0);
      const merged=mergeRows(prior.rows,got.rows),added=Math.max(0,merged.length-prior.rows.length),cursor=got.historyExhausted?prior.cursor:(got.lastScannedSignature||prior.cursor);totalRowsAdded+=added;const zeroProgressReason=reasonFor(got,added,enabled),providerCallsTotal=prior.providerCallsTotal+calls,rowsAddedTotal=prior.rowsAddedTotal+added,zeroProgressStreak=added>0?0:prior.zeroProgressStreak+1,informationYield=yieldOf(providerCallsTotal,rowsAddedTotal);
      const next:ProgressiveWalletState={schemaVersion:2,address:c.address,updatedAt:now(),cursor:cursor||null,historyComplete:Boolean(prior.historyComplete||got.historyExhausted),rows:merged,lastProgressAt:added>0?now():prior.lastProgressAt||null,zeroProgressReason,scanCount:prior.scanCount+1,providerCallsTotal,rowsAddedTotal,zeroProgressStreak,lastProviderCalls:calls,lastRowsAdded:added,informationYield};
      await atomic(evidencePath(c.address),next);
      wallets.push({address:c.address,priorityTier:c.priorityTier,deficit:c.deficit,beforeSignature:before,afterSignature:next.cursor,providerCalls:calls,transactionsConsidered:Number(got.transactionsConsidered||0),cacheHits:Number(got.cacheHits||0),rowsFetched:got.rows.length,rowsAdded:added,rowsTotal:merged.length,historyComplete:next.historyComplete,budgetExhausted:Boolean(got.budgetExhausted),zeroProgressReason,informationYieldBefore,informationYieldAfter:informationYield,zeroProgressStreak,walletBudget});
    }catch(e){
      const zeroProgressReason=`PROGRESSIVE_FETCH_FAILED:${e instanceof Error?e.message:String(e)}`.slice(0,240),zeroProgressStreak=prior.zeroProgressStreak+1;const next={...prior,updatedAt:now(),zeroProgressReason,scanCount:prior.scanCount+1,zeroProgressStreak,lastProviderCalls:0,lastRowsAdded:0};await atomic(evidencePath(c.address),next);wallets.push({address:c.address,priorityTier:c.priorityTier,deficit:c.deficit,beforeSignature:before,afterSignature:before,providerCalls:0,transactionsConsidered:0,cacheHits:0,rowsFetched:0,rowsAdded:0,rowsTotal:prior.rows.length,historyComplete:prior.historyComplete,budgetExhausted:false,zeroProgressReason,informationYieldBefore,informationYieldAfter:prior.informationYield,zeroProgressStreak,walletBudget});
    }
  }
  await flushTransactionFabricCache();
  const out={schemaVersion:2,event:"shark_scout_progressive_evidence_complete",startedAt,finishedAt:now(),policy:{mode:"G0_SIGNATURE_CENSUS_PLUS_G1_BOUNDED_TX_SAMPLE",providerNeutral:true,liveAndExplicitPriorityFirst:true,yieldAwareScheduling:true,adaptivePerWalletBudget:true,noOdinMutation:true,noNewProviderDependency:true,maxWallets:MAX_WALLETS,maxProviderCalls:MAX_PROVIDER_CALLS,maxProviderCallsPerWallet:MAX_PROVIDER_CALLS_PER_WALLET,maxTransactionsPerWallet:MAX_TX_PER_WALLET,pageLimit:PAGE_LIMIT},selectedWallets:selected.length,totalProviderCalls:totalCalls,remainingProviderCalls:remaining,totalTransactionsConsidered:totalTransactions,totalCacheHits,totalRowsFetched,totalRowsAdded,informationYield:yieldOf(totalCalls,totalRowsAdded),progressWallets:wallets.filter(x=>x.rowsAdded>0).length,zeroProgressWallets:wallets.filter(x=>x.rowsAdded===0).length,wallets};
  await atomic(STATE_PATH,out);console.log(JSON.stringify(out));return out;
}
