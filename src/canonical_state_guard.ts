import { promises as fs } from "node:fs";
import path from "node:path";

const CP_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"./data/gauntlet-state.json";
const GUARD_PATH=process.env.SCOUT_CANONICAL_GUARD_PATH||"./data/canonical-replay-guard.json";

type GuardEntry={canonicalReplay:any;capturedAt:string};
type Guard={schemaVersion:number;updatedAt:string;entries:Record<string,GuardEntry>};

async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function trips(x:any){return Number(x?.roundTrips?.length||x?.trusted?.trades||0);}
function rows(x:any){return Number(x?.historyRows||0);}
function stronger(a:any,b:any){const at=trips(a),bt=trips(b);if(at!==bt)return at>bt?a:b;const ar=rows(a),br=rows(b);if(ar!==br)return ar>br?a:b;if(Boolean(a?.historyComplete)!==Boolean(b?.historyComplete))return a?.historyComplete?a:b;return a||b;}

async function snapshot(){const cp=await readJson(CP_PATH,{results:{}}),old:Guard=await readJson(GUARD_PATH,{schemaVersion:1,updatedAt:new Date(0).toISOString(),entries:{}}),entries={...old.entries};let seen=0,improved=0;for(const [address,r] of Object.entries(cp?.results||{}) as any){const c=r?.canonicalReplay;if(!c||trips(c)<=0)continue;seen++;const prev=entries[address]?.canonicalReplay,keep=prev?stronger(prev,c):c;if(!prev||keep===c&&trips(c)>trips(prev)){entries[address]={canonicalReplay:keep,capturedAt:new Date().toISOString()};improved++;}else if(prev){entries[address]={canonicalReplay:keep,capturedAt:entries[address].capturedAt};}}
 const out:Guard={schemaVersion:1,updatedAt:new Date().toISOString(),entries};await atomic(GUARD_PATH,out);console.log(JSON.stringify({event:"canonical_guard_snapshot",seen,improved,guarded:Object.keys(entries).length}));}

async function restore(){const cp=await readJson(CP_PATH,{results:{}}),guard:Guard=await readJson(GUARD_PATH,{schemaVersion:1,updatedAt:new Date(0).toISOString(),entries:{}});let restored=0,protectedStronger=0;for(const [address,g] of Object.entries(guard.entries||{})){const r=cp?.results?.[address];if(!r)continue;const current=r.canonicalReplay,keep=current?stronger(current,g.canonicalReplay):g.canonicalReplay;if(!current||keep===g.canonicalReplay&&trips(g.canonicalReplay)>trips(current)){r.canonicalReplay=g.canonicalReplay;restored++;}else if(current&&keep===current)protectedStronger++;}
 cp.updatedAt=new Date().toISOString();await atomic(CP_PATH,cp);console.log(JSON.stringify({event:"canonical_guard_restore",guarded:Object.keys(guard.entries||{}).length,restored,protectedStronger}));}

const mode=String(process.argv[2]||"").toLowerCase();
if(mode==="snapshot")snapshot().catch(fail);else if(mode==="restore")restore().catch(fail);else{console.error("usage: canonical_state_guard snapshot|restore");process.exitCode=2;}
function fail(e:unknown){console.error(JSON.stringify({event:"canonical_guard_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;}
