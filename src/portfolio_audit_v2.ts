import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const KEY=process.env.HELIUS_API_KEY?.trim();
const WALLET=process.env.SCOUT_WALLET_ADDRESS?.trim();
const OUT=process.env.SCOUT_PORTFOLIO_PATH||"/data/portfolio-audit.json";
const CACHE=process.env.SCOUT_PORTFOLIO_HISTORY_CACHE||"/data/portfolio-history-cache.json";
const SIG_LIMIT=clamp(Number(process.env.PORTFOLIO_SIGNATURE_LIMIT||250),50,500);
const TOKEN_SIG_LIMIT=clamp(Number(process.env.PORTFOLIO_TOKEN_ACCOUNT_SIGNATURE_LIMIT||100),25,250);
const MAX_POS=clamp(Number(process.env.PORTFOLIO_MAX_POSITIONS||25),5,50);
const TIMEOUT=clamp(Number(process.env.REQUEST_TIMEOUT_MS||25000),3000,60000);
const WSOL="So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
type AnyObj=Record<string,any>;
type Event={signature:string;ts:number|null;mint:string;side:"BUY"|"SELL";qty:number;sol:number;confidence:"HIGH"|"MEDIUM";quote:"NATIVE_SOL"|"WSOL"};
type Movement={signature:string;ts:number|null;nativeSolDelta:number;tokenDeltas:Array<{mint:string;delta:number}>;multiToken:boolean};
type TokenAccount={address:string;mint:string;programId:string};
type Lot={qty:number;cost:number};
type Book={lots:Lot[];realized:number;realizedCost:number;lastBuy:number|null;lastSell:number|null;buys:number;sells:number;incomplete:boolean;lastTs:number|null};
function clamp(n:number,min:number,max:number){return Math.max(min,Math.min(max,Number.isFinite(n)?Math.floor(n):min));}
function now(){return new Date().toISOString();}
function valid(v?:string){if(!v)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}}
async function readJson(f:string,d:any){try{return JSON.parse(await fs.readFile(f,"utf8"));}catch{return d;}}
async function save(f:string,d:any){await fs.mkdir(path.dirname(f),{recursive:true});const t=`${f}.${process.pid}.tmp`;await fs.writeFile(t,JSON.stringify(d));await fs.rename(t,f);}
async function rpc(method:string,params:any[]){const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT);try{const r=await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(KEY!)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:c.signal});const b=await r.json() as AnyObj;if(!r.ok||b?.error)throw new Error(`rpc_${method}:${b?.error?.message||r.status}`);return b?.result;}finally{clearTimeout(t);}}
function keyOf(x:any){return typeof x==="string"?x:String(x?.pubkey||"");}
function agg(list:any[],owner:string){const m=new Map<string,number>();for(const b of list||[]){if(String(b?.owner||"")!==owner)continue;const mint=String(b?.mint||""),q=Number(b?.uiTokenAmount?.uiAmountString||0);if(mint)m.set(mint,(m.get(mint)||0)+q);}return m;}
function analyze(tx:any,sig:string,ts:number|null):{event:Event|null;movement:Movement|null}{
  const keys=tx?.transaction?.message?.accountKeys||[],i=keys.findIndex((k:any)=>keyOf(k)===WALLET),preLam=i>=0?Number(tx?.meta?.preBalances?.[i]||0):0,postLam=i>=0?Number(tx?.meta?.postBalances?.[i]||0):0,nativeSolDelta=i>=0?(postLam-preLam)/1e9:0;
  const pre=agg(tx?.meta?.preTokenBalances||[],WALLET!),post=agg(tx?.meta?.postTokenBalances||[],WALLET!),mints=new Set([...pre.keys(),...post.keys()]);
  const tokenDeltas=[...mints].map(m=>({mint:m,delta:(post.get(m)||0)-(pre.get(m)||0)})).filter(x=>Math.abs(x.delta)>1e-9);
  if(!tokenDeltas.length)return{event:null,movement:null};
  const movement:Movement={signature:sig,ts,nativeSolDelta,tokenDeltas,multiToken:tokenDeltas.filter(x=>x.mint!==WSOL).length>1};
  const nonWsol=tokenDeltas.filter(x=>x.mint!==WSOL),wsolDelta=tokenDeltas.find(x=>x.mint===WSOL)?.delta||0;
  let side:"BUY"|"SELL"|null=null,quoteSol=0,quote:"NATIVE_SOL"|"WSOL"="NATIVE_SOL",candidates:Array<{mint:string;delta:number}>=[];
  if(nativeSolDelta<-.0005){side="BUY";quoteSol=Math.abs(nativeSolDelta);candidates=nonWsol.filter(x=>x.delta>0);}else if(nativeSolDelta>.0005){side="SELL";quoteSol=Math.abs(nativeSolDelta);candidates=nonWsol.filter(x=>x.delta<0);}else if(wsolDelta< -1e-9){side="BUY";quoteSol=Math.abs(wsolDelta);quote="WSOL";candidates=nonWsol.filter(x=>x.delta>0);}else if(wsolDelta>1e-9){side="SELL";quoteSol=Math.abs(wsolDelta);quote="WSOL";candidates=nonWsol.filter(x=>x.delta<0);}
  if(!side||candidates.length!==1)return{event:null,movement};
  const x=candidates[0]!,qty=Math.abs(x.delta);if(qty<=0)return{event:null,movement};
  const confidence:Event["confidence"]=nonWsol.length===1?"HIGH":"MEDIUM";
  return{event:{signature:sig,ts,mint:x.mint,side,qty,sol:quoteSol,confidence,quote},movement};
}
async function balances(){
  const results=await Promise.all([TOKEN_PROGRAM,TOKEN_2022_PROGRAM].map(programId=>rpc("getTokenAccountsByOwner",[WALLET,{programId},{encoding:"jsonParsed",commitment:"confirmed"}]))),m=new Map<string,number>(),accounts:TokenAccount[]=[];
  for(let idx=0;idx<results.length;idx++){const r=results[idx],programId=idx===0?TOKEN_PROGRAM:TOKEN_2022_PROGRAM;for(const row of r?.value||[]){const i=row?.account?.data?.parsed?.info,mint=String(i?.mint||""),q=Number(i?.tokenAmount?.uiAmountString||0),address=String(row?.pubkey||"");if(mint&&address)accounts.push({address,mint,programId});if(mint&&q>0)m.set(mint,(m.get(mint)||0)+q);}}
  return{balances:m,accounts};
}
async function signatureRows(accounts:TokenAccount[]){
  const sources=[WALLET!,...accounts.map(a=>a.address)],bySig=new Map<string,any>();let sourceErrors=0;
  for(let idx=0;idx<sources.length;idx++){const address=sources[idx]!,limit=idx===0?SIG_LIMIT:TOKEN_SIG_LIMIT;try{const rows=await rpc("getSignaturesForAddress",[address,{limit,commitment:"confirmed"}]);for(const s of rows||[]){const sig=String(s?.signature||"");if(sig&&!bySig.has(sig))bySig.set(sig,s);}}catch{sourceErrors++;}}
  return{rows:[...bySig.values()],sourcesScanned:sources.length,sourceErrors};
}
async function history(current:Map<string,number>,accounts:TokenAccount[]){
  let cache=await readJson(CACHE,{schemaVersion:2,events:{},movements:{},seen:{}});if(cache?.schemaVersion!==2)cache={schemaVersion:2,events:{},movements:{},seen:{}};cache.events=cache.events||{};cache.movements=cache.movements||{};cache.seen=cache.seen||{};
  const sigData=await signatureRows(accounts),sigRows=sigData.rows;let rpcFetched=0,cacheHits=0,ambiguous=0;
  for(const s of sigRows){const sig=String(s?.signature||"");if(!sig)continue;if(cache.seen[sig]){cacheHits++;continue;}try{const tx=await rpc("getTransaction",[sig,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}]);rpcFetched++;if(tx?.meta&&!tx.meta.err){const a=analyze(tx,sig,s?.blockTime??tx?.blockTime??null);if(a.event)cache.events[sig]=a.event;if(a.movement)cache.movements[sig]=a.movement;if(!a.event&&!a.movement)ambiguous++;}cache.seen[sig]=1;}catch{cache.seen[sig]=1;ambiguous++;}}
  const keep=new Set(sigRows.map((s:any)=>String(s?.signature||"")));for(const k of Object.keys(cache.seen))if(!keep.has(k)){delete cache.seen[k];delete cache.events[k];delete cache.movements[k];}await save(CACHE,cache);
  const events=(Object.values(cache.events) as Event[]).sort((a,b)=>Number(a.ts||0)-Number(b.ts||0)),movements=(Object.values(cache.movements) as Movement[]).sort((a,b)=>Number(a.ts||0)-Number(b.ts||0)),books=new Map<string,Book>();const get=(m:string)=>{let b=books.get(m);if(!b){b={lots:[],realized:0,realizedCost:0,lastBuy:null,lastSell:null,buys:0,sells:0,incomplete:false,lastTs:null};books.set(m,b);}return b;};
  for(const e of events){const b=get(e.mint);b.lastTs=e.ts;if(e.side==="BUY"){b.lots.push({qty:e.qty,cost:e.sol});b.buys++;b.lastBuy=e.sol/e.qty;}else{let rem=e.qty,cost=0;while(rem>1e-12&&b.lots.length){const l=b.lots[0]!,take=Math.min(rem,l.qty),unit=l.qty>0?l.cost/l.qty:0;cost+=take*unit;l.qty-=take;l.cost-=take*unit;rem-=take;if(l.qty<=1e-12)b.lots.shift();}if(rem>Math.max(1e-9,e.qty*.001))b.incomplete=true;b.realized+=e.sol-cost;b.realizedCost+=cost;b.sells++;b.lastSell=e.sol/e.qty;}}
  for(const [m,q] of current){const b=get(m),known=b.lots.reduce((s,l)=>s+l.qty,0);if(q>known+Math.max(1e-8,q*.001))b.incomplete=true;}
  const routeStats=new Map<string,{multiToken:number;inbound:number;outbound:number}>();for(const mv of movements){if(!mv.multiToken)continue;for(const d of mv.tokenDeltas.filter(x=>x.mint!==WSOL)){const s=routeStats.get(d.mint)||{multiToken:0,inbound:0,outbound:0};s.multiToken++;if(d.delta>0)s.inbound++;else s.outbound++;routeStats.set(d.mint,s);}}
  return{books,events,movements,routeStats,transactionsScanned:sigRows.length,rpcFetched,cacheHits,ambiguous,signatureSourcesScanned:sigData.sourcesScanned,signatureSourceErrors:sigData.sourceErrors};
}
async function price(mint:string){const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT);try{const r=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`,{signal:c.signal});if(!r.ok)return{symbol:null as string|null,usd:null as number|null};const b=await r.json() as AnyObj,pairs=(Array.isArray(b?.pairs)?b.pairs:[]).filter((p:any)=>p?.chainId==="solana"&&p?.baseToken?.address===mint).sort((a:any,b:any)=>Number(b?.liquidity?.usd||0)-Number(a?.liquidity?.usd||0)),p=pairs[0];return{symbol:p?.baseToken?.symbol?String(p.baseToken.symbol):null,usd:Number.isFinite(Number(p?.priceUsd))?Number(p.priceUsd):null};}catch{return{symbol:null,usd:null};}finally{clearTimeout(t);}}
function reconcile(previous:any,current:Map<string,number>,movements:Movement[]){
  const prev=new Map<string,number>((Array.isArray(previous?.positions)?previous.positions:[]).map((p:any)=>[String(p?.mint||""),Number(p?.quantity||0)])),previousAt=Date.parse(String(previous?.finishedAt||"")),cutoff=Number.isFinite(previousAt)?Math.floor(previousAt/1000):0,recent=movements.filter(m=>Number(m.ts||0)>=cutoff),mentioned=new Set(recent.flatMap(m=>m.tokenDeltas.map(d=>d.mint))),mints=new Set([...prev.keys(),...current.keys()]),unexplained:any[]=[];let changed=0,explained=0;
  for(const mint of mints){if(!mint)continue;const before=prev.get(mint)||0,after=current.get(mint)||0,tol=Math.max(1e-9,Math.max(before,after)*.001);if(Math.abs(after-before)<=tol){explained++;continue;}changed++;if(mentioned.has(mint))explained++;else unexplained.push({mint,previousQuantity:before,currentQuantity:after,delta:after-before});}
  return{inventoryCount:current.size,previousInventoryCount:prev.size,changedMints:changed,explainedMints:explained,unexplainedCount:unexplained.length,unexplained,status:unexplained.length?"WARNING":"OK"};
}
async function main(){
  const startedAt=now(),base:any={event:"shark_scout_portfolio_complete",version:3,startedAt,enabled:Boolean(KEY&&valid(WALLET)),walletConfigured:Boolean(WALLET),errors:[],warnings:[]};if(!KEY||!valid(WALLET)){console.log(JSON.stringify({...base,finishedAt:now(),skipped:!KEY?"missing_helius_key":"missing_or_invalid_wallet"}));return;}
  try{const previous=await readJson(OUT,null),[lam,inventory]=await Promise.all([rpc("getBalance",[WALLET,{commitment:"confirmed"}]),balances()]),bals=inventory.balances,h=await history(bals,inventory.accounts),solM=await price(WSOL),solUsd=solM.usd,rows:any[]=[];
    for(const [mint,q] of [...bals.entries()].sort((a,b)=>b[1]-a[1]).slice(0,MAX_POS)){const [m,b]=await Promise.all([price(mint),Promise.resolve(h.books.get(mint))]),route=h.routeStats.get(mint),openQty=b?b.lots.reduce((s,l)=>s+l.qty,0):0,openCost=b?b.lots.reduce((s,l)=>s+l.cost,0):0,valueUsd=m.usd!=null?m.usd*q:null,valueSol=valueUsd!=null&&solUsd?valueUsd/solUsd:null,incomplete=!b||b.incomplete,unreal=valueSol!=null&&!incomplete?valueSol-openCost:null,total=unreal!=null?(b?.realized||0)+unreal:null,totalCost=!incomplete?(b?.realizedCost||0)+openCost:null,routeIntermediate=Boolean(route&&route.multiToken>0&&route.inbound>0&&route.outbound>0&&(!b||b.buys===0));rows.push({symbol:m.symbol||mint.slice(0,6),mint,quantity:q,currentPriceUsd:m.usd,currentValueUsd:valueUsd,currentValueSol:valueSol,entryPriceSolPerToken:openQty>0?openCost/openQty:b?.lastBuy||null,lastExitPriceSolPerToken:b?.lastSell||null,openCostSol:incomplete?null:openCost,realizedPnlSol:b?.realized||0,unrealizedPnlSol:unreal,totalPnlSol:total,totalPnlPct:total!=null&&totalCost&&totalCost>0?100*total/totalCost:null,buysSeen:b?.buys||0,sellsSeen:b?.sells||0,costBasisStatus:incomplete?"PARTIAL_OR_UNKNOWN":"RECONSTRUCTED",routeRole:routeIntermediate?"ROUTE_INTERMEDIATE":"POSITION_OR_UNKNOWN",routeEvidence:route||null,lastTradeAt:b?.lastTs?new Date(b.lastTs*1000).toISOString():null});}
    rows.sort((a,b)=>Number(b.currentValueUsd||0)-Number(a.currentValueUsd||0));const reconciliation=reconcile(previous,bals,h.movements);if(reconciliation.status==="WARNING")base.warnings.push("PORTFOLIO_RECONCILIATION_WARNING");const solBalance=Number(lam?.value||0)/1e9,tokenValueUsd=rows.reduce((s,r)=>s+Number(r.currentValueUsd||0),0),out={...base,finishedAt:now(),solBalance,solPriceUsd:solUsd,portfolioValueUsd:solUsd?solBalance*solUsd+tokenValueUsd:tokenValueUsd||null,tokenPositionCount:rows.length,tokenAccountCount:inventory.accounts.length,positions:rows,reconciliation,transactionsScanned:h.transactionsScanned,newTransactionsFetched:h.rpcFetched,historyCacheHits:h.cacheHits,ambiguousTransactions:h.ambiguous,classifiedTradeEvents:h.events.length,movementEvents:h.movements.length,signatureSourcesScanned:h.signatureSourcesScanned,signatureSourceErrors:h.signatureSourceErrors};await save(OUT,out);console.log(JSON.stringify(out));if(reconciliation.status==="WARNING")console.warn(JSON.stringify({event:"shark_scout_portfolio_reconciliation_warning",...reconciliation}));
  }catch(e){base.errors.push(e instanceof Error?e.message:String(e));console.log(JSON.stringify({...base,finishedAt:now()}));}}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_portfolio_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
