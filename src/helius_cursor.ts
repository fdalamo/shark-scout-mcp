type FetchCursorOptions={
  apiKey:string;
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
};

function sig(x:any){const s=String(x?.signature||"").trim();return s||null;}

export async function fetchHeliusCursor(opts:FetchCursorOptions):Promise<CursorFetchResult>{
  const pageLimit=Math.max(20,Math.min(100,Math.floor(opts.pageLimit||100)));
  const maxPages=Math.max(1,Math.min(8,Math.floor(opts.maxPages||3)));
  const timeoutMs=Math.max(5000,Math.min(60_000,Math.floor(opts.timeoutMs||25_000)));
  const stop=opts.stopSignature?.trim()||null;
  const out:any[]=[];
  const seen=new Set<string>();
  let before:string|null=null,newest:string|null=null,oldest:string|null=null,reachedStop=false,pagesFetched=0,truncated=false;
  for(let page=0;page<maxPages;page++){
    const q=new URLSearchParams({"api-key":opts.apiKey,limit:String(pageLimit),type:opts.type||"SWAP"});
    if(before)q.set("before",before);
    const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs);
    let rows:any[]=[];
    try{
      const r=await fetch(`https://api.helius.xyz/v0/addresses/${opts.address}/transactions?${q}`,{signal:c.signal});
      if(!r.ok)throw new Error(`${r.status}:${(await r.text()).slice(0,160)}`);
      const x=await r.json();rows=Array.isArray(x)?x:[];
    } finally {clearTimeout(timer);}
    pagesFetched++;
    if(page===0)newest=sig(rows[0]);
    for(const row of rows){
      const s=sig(row);if(!s)continue;
      if(stop&&s===stop){reachedStop=true;break;}
      if(!seen.has(s)){seen.add(s);out.push(row);oldest=s;}
    }
    if(reachedStop||rows.length<pageLimit)break;
    const tail=sig(rows[rows.length-1]);
    if(!tail||tail===before)break;
    before=tail;
    if(page===maxPages-1)truncated=true;
  }
  return{rows:out,newestSignature:newest,oldestSignature:oldest,stopSignature:stop,reachedStop,pagesFetched,truncated};
}
