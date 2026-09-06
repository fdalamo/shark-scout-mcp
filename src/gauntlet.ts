import { promises as fs } from "node:fs";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const VYBE_API_KEY = process.env.VYBE_API_KEY?.trim();
const STATE_PATH = process.env.SCOUT_STATE_PATH || "./data/shark-state.json";
const REPORT_PATH = process.env.SCOUT_GAUNTLET_PATH || "./data/latest-gauntlet.json";
const LIMIT = Math.max(5, Math.min(Number(process.env.GAUNTLET_WALLET_LIMIT || 20), 50));
const TIMEOUT_MS = Math.max(3000, Math.min(Number(process.env.REQUEST_TIMEOUT_MS || 15000), 60000));
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const QUOTES = new Set([WSOL, USDC, USDT]);

type Wallet = { address:string; status?:string; tokens?:string[]; providers?:string[]; rediscoveryCount?:number; tags?:string[]; discovery?:Record<string,any>; profile?:Record<string,any> };

type HoldStats = { closedHolds:number; medianHoldSeconds:number|null; p25HoldSeconds:number|null; p75HoldSeconds:number|null; fastUnder10m:number; slowOver6h:number; idealOver12h:number; buyEvents:number; sellEvents:number; sourceRoundTrips:Array<{mint:string;holdSeconds:number;buySol:number|null;sellSol:number|null;roi:number|null}> };

function median(v:number[]):number|null { if(!v.length) return null; const a=[...v].sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2; }
function quantile(v:number[],q:number):number|null { if(!v.length)return null; const a=[...v].sort((x,y)=>x-y); return a[Math.min(a.length-1,Math.floor((a.length-1)*q))]!; }
function scoreWallet(w:Wallet):number { return (w.tokens?.length||0)*100+(w.providers?.length||0)*25+Math.min(w.rediscoveryCount||0,25); }
function badTag(tags:string[]=[]):string|null { const s=tags.join(" ").toLowerCase(); for(const x of ["sniper","bundler","insider","developer","bot","mev","exchange","cex"]) if(s.includes(x)) return x; return null; }
async function fetchJson(url:string,init:RequestInit={}):Promise<any>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),TIMEOUT_MS); try{ const r=await fetch(url,{...init,signal:c.signal}); const tx=await r.text(); if(!r.ok) throw new Error(`${r.status}: ${tx.slice(0,240)}`); return tx?JSON.parse(tx):null; } finally{clearTimeout(t);} }
async function helius(address:string):Promise<any[]>{ if(!HELIUS_API_KEY)return []; try{ const q=new URLSearchParams({"api-key":HELIUS_API_KEY,limit:"100"}); const x=await fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${q}`); return Array.isArray(x)?x:[]; }catch{return [];} }
async function vybeTrades(address:string):Promise<{rows:any[];error:string|null}>{ if(!VYBE_API_KEY)return {rows:[],error:"VYBE_API_KEY missing"}; try{ const end=Math.floor(Date.now()/1000); const start=end-30*86400; const q=new URLSearchParams({authorityAddress:address,timeStart:String(start),timeEnd:String(end),limit:"500",page:"0",sortByAsc:"blockTime"}); const x=await fetchJson(`https://api.vybenetwork.xyz/v4/trades?${q}`,{headers:{"X-API-Key":VYBE_API_KEY}}); return {rows:Array.isArray(x?.data)?x.data:[],error:null}; }catch(e){return {rows:[],error:String(e)};} }
function nativeSol(x:any):number|null { const n=Number(x?.amount); return Number.isFinite(n)?n/1e9:null; }
function holdStats(rows:any[],wallet:string):HoldStats {
  const ordered=[...rows].filter(x=>x?.type==="SWAP"&&Number.isFinite(Number(x?.timestamp))).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp));
  const open=new Map<string,Array<{t:number;sol:number|null}>>(); const rts:HoldStats["sourceRoundTrips"]=[]; let buys=0,sells=0;
  for(const tx of ordered){ const ev=tx?.events?.swap; if(!ev)continue; const t=Number(tx.timestamp);
    const outs=(ev.tokenOutputs||[]).filter((x:any)=>x?.userAccount===wallet&&!QUOTES.has(x?.mint));
    const ins=(ev.tokenInputs||[]).filter((x:any)=>x?.userAccount===wallet&&!QUOTES.has(x?.mint));
    for(const o of outs){ buys++; const arr=open.get(o.mint)||[]; arr.push({t,sol:nativeSol(ev.nativeInput)}); open.set(o.mint,arr); }
    for(const i of ins){ sells++; const arr=open.get(i.mint)||[]; if(arr.length){ const b=arr.shift()!; const sellSol=nativeSol(ev.nativeOutput); const roi=b.sol&&sellSol!=null?((sellSol-b.sol)/b.sol):null; rts.push({mint:i.mint,holdSeconds:Math.max(0,t-b.t),buySol:b.sol,sellSol,roi}); open.set(i.mint,arr); } }
  }
  const holds=rts.map(x=>x.holdSeconds); return {closedHolds:holds.length,medianHoldSeconds:median(holds),p25HoldSeconds:quantile(holds,.25),p75HoldSeconds:quantile(holds,.75),fastUnder10m:holds.filter(x=>x<600).length,slowOver6h:holds.filter(x=>x>=21600).length,idealOver12h:holds.filter(x=>x>=43200).length,buyEvents:buys,sellEvents:sells,sourceRoundTrips:rts.slice(-20)};
}
function pnlSignals(w:Wallet){ const p:any=w.profile?.vybe30d||{}; const realized=Number(p.realizedPnlUsd); const wr=Number(p.winRate); const trades=Number(p.tradesCount); return {realizedPnlUsd:Number.isFinite(realized)?realized:null,winRate:Number.isFinite(wr)?wr:null,tradesCount:Number.isFinite(trades)?trades:null}; }
function verdict(w:Wallet,h:HoldStats,trades:any[],vybeError:string|null){ const reasons:string[]=[]; const tag=badTag(w.tags); if(tag)return {status:"REJECT",stage:"hard_gate",reasons:[`bad_tag:${tag}`]};
  const med=h.medianHoldSeconds; if(med!=null&&med<600)return {status:"REJECT",stage:"hold_time",reasons:[`median_hold_${Math.round(med)}s_under_10m`]};
  if(med!=null&&med<3600)return {status:"SIGNAL_ONLY",stage:"hold_time",reasons:[`median_hold_${Math.round(med/60)}m_under_1h`]};
  if(h.closedHolds<3) reasons.push("closed_hold_sample_under_3");
  if(med==null) reasons.push("hold_time_unknown"); else if(med<21600) reasons.push("median_hold_under_6h"); else if(med>=43200) reasons.push("median_hold_12h_plus"); else reasons.push("median_hold_6h_plus");
  if(trades.length>=400) reasons.push("high_activity_30d_400plus");
  if((w.tokens?.length||0)<2) reasons.push("single_discovery_token"); else reasons.push(`cross_token_${w.tokens!.length}`);
  if(vybeError) reasons.push("vybe_trade_history_error");
  const p=pnlSignals(w); if(p.realizedPnlUsd!=null&&p.realizedPnlUsd<=0) return {status:"REJECT",stage:"economics",reasons:[...reasons,"nonpositive_30d_realized_pnl"]};
  if(med!=null&&med>=21600&&h.closedHolds>=3&&(w.tokens?.length||0)>=2&&trades.length<400) return {status:"DEEP_DIVE",stage:"pre_replay",reasons:[...reasons,"needs_raw_equal_size_odin_replay"]};
  return {status:"UNKNOWN",stage:"insufficient_evidence",reasons};
}
export async function runGauntlet(){ const state=JSON.parse(await fs.readFile(STATE_PATH,"utf8")); const wallets=(Object.values(state.wallets||{}) as Wallet[]).filter(w=>w.status!=="REJECTED").sort((a,b)=>scoreWallet(b)-scoreWallet(a)).slice(0,LIMIT); const results=[] as any[];
  for(const w of wallets){ const [hx,vt]=await Promise.all([helius(w.address),vybeTrades(w.address)]); const hs=holdStats(hx,w.address); const v=verdict(w,hs,vt.rows,vt.error); results.push({address:w.address,discoveryTokens:w.tokens?.length||0,providers:w.providers||[],rediscoveryCount:w.rediscoveryCount||0,heliusSwaps:hx.filter(x=>x?.type==="SWAP").length,vybeTrades30d:vt.rows.length,hold:hs,pnl:pnlSignals(w),verdict:v}); }
  const counts=results.reduce((a:any,x:any)=>(a[x.verdict.status]=(a[x.verdict.status]||0)+1,a),{}); const report={generatedAt:new Date().toISOString(),evaluated:results.length,counts,note:"DEEP_DIVE is not a final live-test pass. Full pass still requires raw economics, 0.075-SOL equal-size replay, Odin fees/tips/slippage, lag stress and anti-jackpot review.",results}; await fs.mkdir(REPORT_PATH.substring(0,REPORT_PATH.lastIndexOf("/")),{recursive:true}); await fs.writeFile(REPORT_PATH,JSON.stringify(report,null,2)); console.log(JSON.stringify({event:"shark_scout_gauntlet_complete",generatedAt:report.generatedAt,evaluated:report.evaluated,counts,top:results.slice(0,10).map(x=>({address:x.address,status:x.verdict.status,medianHoldSeconds:x.hold.medianHoldSeconds,closedHolds:x.hold.closedHolds,discoveryTokens:x.discoveryTokens,vybeTrades30d:x.vybeTrades30d,reasons:x.verdict.reasons}))})); return report; }
if(import.meta.url===`file://${process.argv[1]}`) runGauntlet().catch(e=>{console.error(e instanceof Error?e.stack||e.message:String(e));process.exitCode=1;});
