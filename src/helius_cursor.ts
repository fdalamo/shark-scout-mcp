import { fetchNormalizedHistory } from "./transaction_fabric.js";

type FetchCursorOptions={
  apiKey?:string;
  address:string;
  stopSignature?:string|null;
  pageLimit?:number;
  maxPages?:number;
  timeoutMs?:number;
  type?:string;
};

export type CursorFetchResult={
  rows:any[];
  newestSignature:string|null;
  oldestSignature:string|null;
  stopSignature:string|null;
  reachedStop:boolean;
  pagesFetched:number;
  truncated:boolean;
  source?:string;
  providerCalls?:number;
  cacheHits?:number;
};

const STANDARD_FIRST=!/^(0|false|no)$/i.test(process.env.TRANSACTION_FABRIC_STANDARD_FIRST||"true");
const ENHANCED_FALLBACK=/^(1|true|yes)$/i.test(process.env.HELIUS_ENHANCED_FALLBACK_ENABLED||"true");
const ENHANCED_MAX_CALLS=Math.max(0,Math.min(50,Number(process.env.HELIUS_ENHANCED_MAX_CALLS_PER_PROCESS||4)));
let enhancedCalls=0;
function sig(x:any){const s=String(x?.signature||"").trim();return s||null;}

async function fetchEnhanced(opts:FetchCursorOptions):Promise<CursorFetchResult>{
  if(!opts.apiKey)throw new Error("helius_enhanced_missing_key");
  if(enhancedCalls>=ENHANCED_MAX_CALLS)throw new Error("helius_enhanced_process_budget_exhausted");
  const pageLimit=Math.max(20,Math.min(100,Math.floor(opts.pageLimit||100)));
  const maxPages=Math.max(1,Math.min(8,Math.floor(opts.maxPages||3)));
  const timeoutMs=Math.max(5000,Math.min(60_000,Math.floor(opts.timeoutMs||25_000)));
  const stop=opts.stopSignature?.trim()||null;
  const out:any[]=[];const seen=new Set<string>();let before:string|null=null,newest:string|null=null,oldest:string|null=null,reachedStop=false,pagesFetched=0,truncated=false;
  for(let page=0;page<maxPages;page++){
    if(enhancedCalls>=ENHANCED_MAX_CALLS){truncated=true;break;}
    const q=new URLSearchParams({"api-key":opts.apiKey,limit:String(pageLimit),type:opts.type||"SWAP"});if(before)q.set("before",before);
    const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs);let rows:any[]=[];
    try{enhancedCalls++;const r=await fetch(`https://api.helius.xyz/v0/addresses/${opts.address}/transactions?${q}`,{signal:c.signal});if(!r.ok)throw new Error(`${r.status}:${(await r.text()).slice(0,160)}`);const x=await r.json();rows=Array.isArray(x)?x:[];}finally{clearTimeout(timer);}
    pagesFetched++;if(page===0)newest=sig(rows[0]);for(const row of rows){const s=sig(row);if(!s)continue;if(stop&&s===stop){reachedStop=true;break;}if(!seen.has(s)){seen.add(s);out.push(row);oldest=s;}}
    if(reachedStop||rows.length<pageLimit)break;const tail=sig(rows[rows.length-1]);if(!tail||tail===before)break;before=tail;if(page===maxPages-1)truncated=true;
  }
  return{rows:out,newestSignature:newest,oldestSignature:oldest,stopSignature:stop,reachedStop,pagesFetched,truncated,source:"helius_enhanced_adjudication",providerCalls:pagesFetched,cacheHits:0};
}

export async function fetchHeliusCursor(opts:FetchCursorOptions):Promise<CursorFetchResult>{
  let standardError:unknown;
  if(STANDARD_FIRST){try{return await fetchNormalizedHistory({address:opts.address,stopSignature:opts.stopSignature,pageLimit:opts.pageLimit,maxPages:opts.maxPages});}catch(e){standardError=e;}}
  if(ENHANCED_FALLBACK&&opts.apiKey){try{return await fetchEnhanced(opts);}catch(e){if(!standardError)standardError=e;}}
  if(!STANDARD_FIRST){try{return await fetchNormalizedHistory({address:opts.address,stopSignature:opts.stopSignature,pageLimit:opts.pageLimit,maxPages:opts.maxPages});}catch(e){standardError=e;}}
  throw standardError instanceof Error?standardError:new Error(String(standardError||"transaction_cursor_failed"));
}
