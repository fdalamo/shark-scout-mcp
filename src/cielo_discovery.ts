const KEY=process.env.CIELO_API_KEY?.trim();
const BASE="https://feed-api.cielo.finance/api/v1";
const TIMEOUT=Math.max(3000,Math.min(60000,Number(process.env.REQUEST_TIMEOUT_MS||25000)));
export type CieloLead={address:string;tags:string[];lanes:string[];tokens:string[];label?:string};
function uniq<T>(x:T[]){return[...new Set(x)];}
function pk(v:any){return typeof v==="string"&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)?v:null;}
function deep(x:any,d=0):any[]{if(d>5||x==null)return[];if(Array.isArray(x))return x.flatMap(v=>[...(v&&typeof v==="object"&&!Array.isArray(v)?[v]:[]),...deep(v,d+1)]);if(typeof x==="object")return Object.values(x).flatMap(v=>deep(v,d+1));return[];}
async function get(path:string,q:URLSearchParams){if(!KEY)return null;const c=new AbortController(),t=setTimeout(()=>c.abort(),TIMEOUT);try{const r=await fetch(`${BASE}${path}?${q}`,{headers:{"X-API-KEY":KEY},signal:c.signal});const text=await r.text();if(!r.ok)throw new Error(`${r.status}:${text.slice(0,120)}`);return text?JSON.parse(text):null;}finally{clearTimeout(t);}}
function walletOf(x:any){for(const k of ["wallet","address","wallet_address","owner"]){const a=pk(x?.[k]);if(a)return a;}return null;}
export async function cieloDiscovery():Promise<{leads:CieloLead[];tokens:string[];errors:string[]}> {const leads=new Map<string,CieloLead>(),tokens:string[]=[],errors:string[]=[];if(!KEY)return{leads:[],tokens:[],errors:["CIELO_API_KEY_missing"]};
 const add=(a:string,tags:string[],lane:string,label?:string)=>{const e=leads.get(a)||{address:a,tags:[],lanes:[],tokens:[]};e.tags=uniq([...e.tags,...tags]);e.lanes=uniq([...e.lanes,lane]);if(label)e.label=label;leads.set(a,e);};
 // High-signal Cielo labels are discovery priors only; Scout still independently reconstructs and gates every wallet.
 for(const tag of ["human-operated","gem-finder","high-winrate"]){try{const q=new URLSearchParams({wallet_type:"solana",limit:"50"});q.append("tags",tag);const b=await get("/tags/wallets",q);for(const r of deep(b)){const a=walletOf(r);if(a)add(a,[tag],"CIELO_TAG",r?.label||r?.wallet_label);}}catch(e){errors.push(`tags:${tag}:${String(e)}`);}}
 // Cielo's unique-wallet trending signal complements Birdeye's token ranking.
 for(const interval of ["1h","24h"]){try{const b=await get("/trending-tokens",new URLSearchParams({chain:"solana",interval,limit:"20"}));for(const r of deep(b)){for(const k of ["address","token_address","mint"]){const a=pk(r?.[k]);if(a)tokens.push(a);}}}catch(e){errors.push(`trending:${interval}:${String(e)}`);}}
 return{leads:[...leads.values()],tokens:uniq(tokens),errors};}
