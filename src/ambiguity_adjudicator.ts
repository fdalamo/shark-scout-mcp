import { promises as fs } from "node:fs";
import path from "node:path";

const ENABLED=String(process.env.CANONICAL_AMBIGUITY_ADJUDICATION_ENABLED||"false").toLowerCase()==="true";
const HELIUS_KEY=process.env.HELIUS_API_KEY?.trim();
const AMBIGUITY_PATH=process.env.CANONICAL_AMBIGUITY_QUEUE_PATH||"/data/canonical-ambiguity-queue.json";
const TX_CACHE_PATH=process.env.TRANSACTION_FABRIC_CACHE_PATH||"/data/transaction-fabric-cache.json";
const OUT_PATH=process.env.CANONICAL_AMBIGUITY_ADJUDICATION_PATH||"/data/canonical-ambiguity-adjudication.json";
const MAX_CALLS=Math.max(0,Math.min(4,Number(process.env.CANONICAL_AMBIGUITY_MAX_CALLS||1)));
const BATCH_SIZE=Math.max(1,Math.min(100,Number(process.env.CANONICAL_AMBIGUITY_BATCH_SIZE||50)));
const TIMEOUT_MS=Math.max(3000,Math.min(30000,Number(process.env.CANONICAL_AMBIGUITY_TIMEOUT_MS||12000)));
const ENDPOINT=(process.env.CANONICAL_AMBIGUITY_HELIUS_ENDPOINT||"https://api.helius.xyz/v0/transactions").trim();

type AnyObj=Record<string,any>;
function now(){return new Date().toISOString();}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
async function parseBatch(signatures:string[]){
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),TIMEOUT_MS);
  try{
    const sep=ENDPOINT.includes("?")?"&":"?";
    const r=await fetch(`${ENDPOINT}${sep}api-key=${encodeURIComponent(HELIUS_KEY!)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transactions:signatures}),signal:c.signal});
    const text=await r.text();
    if(!r.ok)throw new Error(`${r.status}:${text.slice(0,240)}`);
    const x=text?JSON.parse(text):[];return Array.isArray(x)?x:[];
  }finally{clearTimeout(timer);}
}

async function main(){
  const startedAt=now(),queue=await read(AMBIGUITY_PATH,{schemaVersion:1,entries:{}}),entries=Object.values(queue?.entries||{}) as AnyObj[];
  if(!ENABLED||!HELIUS_KEY||MAX_CALLS===0){const out={schemaVersion:1,event:"shark_scout_ambiguity_adjudication_skipped",startedAt,finishedAt:now(),enabled:ENABLED,heliusKeyPresent:Boolean(HELIUS_KEY),maxCalls:MAX_CALLS,backlog:entries.length,reason:!ENABLED?"DISABLED_BY_POLICY":!HELIUS_KEY?"HELIUS_KEY_MISSING":"ZERO_CALL_BUDGET",policy:"Helius Enhanced is reserved for ambiguity adjudication only; bulk history remains provider-neutral."};await atomic(OUT_PATH,out);console.log(JSON.stringify(out));return;}
  const txCache=await read(TX_CACHE_PATH,{schemaVersion:2,updatedAt:now(),transactions:{}});txCache.schemaVersion=2;txCache.transactions||={};
  const pending=entries.sort((a,b)=>Date.parse(String(a?.firstSeenAt||""))-Date.parse(String(b?.firstSeenAt||""))).slice(0,MAX_CALLS*BATCH_SIZE);
  let calls=0,resolved=0,swaps=0,nonSwaps=0;const errors:string[]=[],resolvedSigs=new Set<string>();
  for(let i=0;i<pending.length&&calls<MAX_CALLS;i+=BATCH_SIZE){
    const batch=pending.slice(i,i+BATCH_SIZE),sigs=batch.map(x=>String(x?.signature||"")).filter(Boolean);if(!sigs.length)continue;
    try{
      const rows=await parseBatch(sigs);calls++;
      const bySig=new Map(rows.map((x:any)=>[String(x?.signature||""),x]));
      for(const item of batch){const sig=String(item?.signature||""),address=String(item?.address||""),row=bySig.get(sig) as AnyObj|undefined;if(!sig||!address||!row)continue;const type=String(row?.type||"UNKNOWN").toUpperCase(),isSwap=type==="SWAP"||Boolean(row?.events?.swap);row.source="helius_enhanced_adjudication";txCache.transactions[sig]=txCache.transactions[sig]||{fetchedAt:now(),normalizedByAddress:{}};txCache.transactions[sig].normalizedByAddress=txCache.transactions[sig].normalizedByAddress||{};txCache.transactions[sig].normalizedByAddress[address]=row;txCache.transactions[sig].provider="helius_enhanced_adjudication";txCache.transactions[sig].adjudicatedAt=now();resolved++;isSwap?swaps++:nonSwaps++;resolvedSigs.add(sig);}
    }catch(e){errors.push(e instanceof Error?e.message:String(e));break;}
  }
  if(resolvedSigs.size){for(const sig of resolvedSigs)delete queue.entries[sig];queue.updatedAt=now();txCache.updatedAt=now();await Promise.all([atomic(AMBIGUITY_PATH,queue),atomic(TX_CACHE_PATH,txCache)]);}
  const out={schemaVersion:1,event:errors.length?"shark_scout_ambiguity_adjudication_degraded":"shark_scout_ambiguity_adjudication_complete",startedAt,finishedAt:now(),enabled:true,backlogBefore:entries.length,backlogAfter:Object.keys(queue?.entries||{}).length,calls,batchSize:BATCH_SIZE,resolved,swaps,nonSwaps,errors,policy:"At most the configured small number of Enhanced parse calls; no bulk address-history use and no Odin mutation."};await atomic(OUT_PATH,out);console.log(JSON.stringify(out));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_ambiguity_adjudication_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
