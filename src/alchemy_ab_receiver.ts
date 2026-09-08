import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { ProspectiveLab, manifestHash, normalizeAlchemyPayload, sha256, type EventEnvelope, type Role } from "./prospective_ab_lab.js";
import { FlightRecorder } from "./ab_flight_recorder.js";
import { ProviderRace, RpcReconciler } from "./ab_reconciler.js";
import { byLayer, bootstrapProbabilityPositive, type TradeResult } from "./ab_metrics.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.ALCHEMY_AB_DATA_DIR?.trim() || "/data";
const EVENT_LOG = path.join(DATA_DIR, "alchemy-prospective-events.jsonl");
const STATE_PATH = path.join(DATA_DIR, "alchemy-prospective-state.json");
const RESULTS_LOG = path.join(DATA_DIR, "prospective-ab", "experiment-results.jsonl");
const SIGNING_KEY = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY?.trim() || "";
const RPC_URL = process.env.ALCHEMY_SOLANA_RPC_URL?.trim() || "";
const WSS_URL = process.env.SOLANA_TRACKER_WSS_URL?.trim() || process.env.ALCHEMY_SOLANA_WSS_URL?.trim() || "";
const FOLLOWER_WALLET = process.env.SHARK_FOLLOWER_WALLET?.trim() || "9mVgPUP8eX37KooqxF4aN14UEpeQ2SywRK5rFiy2TSc9";
const LIVE_MIRRORS = new Set((process.env.SHARK_LIVE_MIRRORS ?? "").split(",").map(x => x.trim()).filter(Boolean));
const RESEARCH_COHORT = new Set((process.env.SHARK_RESEARCH_COHORT ?? "").split(",").map(x => x.trim()).filter(Boolean));
const CONTROL_COHORT = new Set((process.env.SHARK_CONTROL_COHORT ?? "").split(",").map(x => x.trim()).filter(Boolean));
const VERSION = "ab-3.0.1";
const RECONCILE_PACE_MS = Math.max(250, Number(process.env.ALCHEMY_AB_RECONCILE_PACE_MS ?? 500));
const lab = new ProspectiveLab(path.join(DATA_DIR, "prospective-ab"));
const subscriptionManifest = { follower: FOLLOWER_WALLET, live: [...LIVE_MIRRORS].sort(), research: [...RESEARCH_COHORT].sort(), controls: [...CONTROL_COHORT].sort() };
const SUBSCRIPTION_MANIFEST_HASH = manifestHash(subscriptionManifest);
const trackedWallets = new Set([FOLLOWER_WALLET, ...LIVE_MIRRORS, ...RESEARCH_COHORT, ...CONTROL_COHORT]);

function roleFor(wallet:string):Role { if(wallet===FOLLOWER_WALLET)return "FOLLOWER"; if(LIVE_MIRRORS.has(wallet))return "LIVE_SOURCE"; if(RESEARCH_COHORT.has(wallet))return "RESEARCH"; if(CONTROL_COHORT.has(wallet))return "CONTROL"; return "TRACKED_UNKNOWN"; }
const race = new ProviderRace(lab);
const flight = new FlightRecorder(lab, SUBSCRIPTION_MANIFEST_HASH);

type State = { schemaVersion:number; startedAt:string; lastReceivedAt:string|null; lastVerifiedAt:string|null; received:number; verified:number; bootstrapAccepted:number; duplicates:number; rejectedSignature:number; malformed:number; bytes:number; envelopes:number; rpcReconciled:number; wssSeen:number; reconcileErrors:number; wssErrors:number; uniqueEventIds:string[] };
function initialState():State{return{schemaVersion:3,startedAt:new Date().toISOString(),lastReceivedAt:null,lastVerifiedAt:null,received:0,verified:0,bootstrapAccepted:0,duplicates:0,rejectedSignature:0,malformed:0,bytes:0,envelopes:0,rpcReconciled:0,wssSeen:0,reconcileErrors:0,wssErrors:0,uniqueEventIds:[]};}
function loadState():State{try{return{...initialState(),...JSON.parse(fs.readFileSync(STATE_PATH,"utf8"))};}catch{return initialState();}}
let state=loadState();let writeQueue:Promise<void>=Promise.resolve();const seen=new Set(state.uniqueEventIds);
function ensureDataDir(){fs.mkdirSync(DATA_DIR,{recursive:true});fs.mkdirSync(path.dirname(RESULTS_LOG),{recursive:true});}
function persistState(){state.uniqueEventIds=Array.from(seen).slice(-20000);const tmp=`${STATE_PATH}.tmp`;fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,STATE_PATH);}
function appendRecord(record:unknown){writeQueue=writeQueue.then(async()=>{ensureDataDir();fs.appendFileSync(EVENT_LOG,JSON.stringify(record)+"\n");persistState();}).catch(err=>console.error(JSON.stringify({level:"error",event:"shark_scout_alchemy_persist_error",error:String(err)})));}
function timingSafeHexEqual(a:string,b:string){try{const aa=Buffer.from(a,"hex"),bb=Buffer.from(b,"hex");return aa.length===bb.length&&aa.length>0&&crypto.timingSafeEqual(aa,bb);}catch{return false;}}
function verifySignature(raw:Buffer,supplied:string){if(!SIGNING_KEY||!supplied)return false;return timingSafeHexEqual(crypto.createHmac("sha256",SIGNING_KEY).update(raw).digest("hex"),supplied);}
function eventId(payload:any,raw:Buffer){return String(payload?.id||payload?.event?.signature||payload?.signature||crypto.createHash("sha256").update(raw).digest("hex"));}
function acceptEnvelope(e:EventEnvelope){lab.commitEnvelope(e);race.seen(e);if(e.role==="LIVE_SOURCE"||e.role==="RESEARCH"||e.role==="CONTROL")flight.source(e);state.envelopes++;}
function sleep(ms:number){return new Promise(resolve=>setTimeout(resolve,ms));}

async function rpcCall(method:string,params:unknown[]){const r=await fetch(RPC_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});if(!r.ok)throw new Error(`rpc_http_${r.status}`);const j:any=await r.json();if(j.error)throw new Error(`rpc_${j.error.code}:${j.error.message}`);return j.result;}
const reconciler = RPC_URL ? new RpcReconciler(path.join(DATA_DIR,"prospective-ab"),lab,rpcCall,roleFor) : null;
let reconcileRunning=false;
async function reconcileTick(){if(!reconciler||reconcileRunning)return;reconcileRunning=true;try{let i=0;for(const wallet of trackedWallets){if(i++>0)await sleep(RECONCILE_PACE_MS);try{const rows=await reconciler.reconcile(wallet,100);for(const e of rows){race.seen(e);if(e.role==="LIVE_SOURCE"||e.role==="RESEARCH"||e.role==="CONTROL")flight.source(e);}state.rpcReconciled+=rows.length;}catch(err){state.reconcileErrors++;console.warn(JSON.stringify({level:"warn",event:"shark_scout_ab_reconcile_error",wallet,error:String(err)}));}}persistState();}finally{reconcileRunning=false;}}

const wssSubs=new Map<string,number>();let wssConnection:Connection|null=null;
function subscribeWallet(wallet:string){if(!wssConnection||wssSubs.has(wallet))return;try{const id=wssConnection.onLogs(new PublicKey(wallet),log=>{const now=new Date().toISOString();const e:EventEnvelope={schemaVersion:2,eventId:sha256(`wss:${wallet}:${log.signature}`),provider:"SOLANA_TRACKER",transport:"tracker_wss",receivedAt:now,providerCreatedAt:null,wallet,role:roleFor(wallet),signature:log.signature,slot:null,blockTime:null,eventType:"LOGS_MENTION",rawPayloadHash:sha256(JSON.stringify(log)),sourceEventId:log.signature,prospectiveEligible:true};acceptEnvelope(e);state.wssSeen++;persistState();},"confirmed");wssSubs.set(wallet,id);}catch(err){state.wssErrors++;console.warn(JSON.stringify({level:"warn",event:"shark_scout_ab_wss_subscribe_error",wallet,error:String(err)}));}}
function startWss(){if(!RPC_URL||!WSS_URL)return;try{wssConnection=new Connection(RPC_URL,{commitment:"confirmed",wsEndpoint:WSS_URL});for(const w of trackedWallets)subscribeWallet(w);console.log(JSON.stringify({level:"info",event:"shark_scout_ab_wss_started",wallets:trackedWallets.size}));}catch(err){state.wssErrors++;console.warn(JSON.stringify({level:"warn",event:"shark_scout_ab_wss_start_error",error:String(err)}));}}

function readResults():TradeResult[]{try{return fs.readFileSync(RESULTS_LOG,"utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x));}catch{return[];}}
function summary(){const rows=readResults();return{layers:byLayer(rows),bootstrapPositive:bootstrapProbabilityPositive(rows),resultCount:rows.length};}

const app=express();app.disable("x-powered-by");
app.get("/health",(_req,res)=>res.json({ok:true,service:"shark-scout-alchemy-ab",version:VERSION,signingKeyConfigured:Boolean(SIGNING_KEY),rpcConfigured:Boolean(RPC_URL),wssConfigured:Boolean(WSS_URL),persistence:DATA_DIR,received:state.received,verified:state.verified,envelopes:state.envelopes,rpcReconciled:state.rpcReconciled,wssSeen:state.wssSeen,duplicates:state.duplicates,manifestHash:SUBSCRIPTION_MANIFEST_HASH,time:new Date().toISOString()}));
app.get("/prospective/status",(_req,res)=>res.json({ok:true,version:VERSION,state:{...state,uniqueEventIds:undefined},manifest:{...subscriptionManifest,hash:SUBSCRIPTION_MANIFEST_HASH},runtime:{rpc:Boolean(RPC_URL),wss:Boolean(WSS_URL),wssSubscriptions:wssSubs.size,reconcileEveryMs:60000,reconcilePaceMs:RECONCILE_PACE_MS,reconcileRunning},metrics:summary(),prospectiveEligibility:SIGNING_KEY?"VERIFIED_ONLY":"BOOTSTRAP_TEST_ONLY"}));

app.post("/webhooks/alchemy/address-activity",express.raw({type:"application/json",limit:"1mb"}),(req:Request,res:Response)=>{
 const receivedAt=new Date().toISOString(),raw=Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body??""),supplied=String(req.header("x-alchemy-signature")??""),verified=verifySignature(raw,supplied),bootstrap=!SIGNING_KEY;state.received++;state.bytes+=raw.length;state.lastReceivedAt=receivedAt;
 if(!bootstrap&&!verified){state.rejectedSignature++;persistState();console.warn(JSON.stringify({level:"warn",event:"shark_scout_alchemy_webhook_rejected",reason:"signature",receivedAt,bytes:raw.length}));res.status(403).json({ok:false});return;}
 let payload:any;try{payload=JSON.parse(raw.toString("utf8"));}catch{state.malformed++;persistState();res.status(400).json({ok:false});return;}
 const id=eventId(payload,raw);if(seen.has(id)){state.duplicates++;persistState();res.status(200).json({ok:true,duplicate:true});return;}seen.add(id);if(verified){state.verified++;state.lastVerifiedAt=receivedAt;}if(bootstrap)state.bootstrapAccepted++;
 const envelopes=normalizeAlchemyPayload({payload,raw,receivedAt,sourceEventId:id,verified,follower:FOLLOWER_WALLET,live:LIVE_MIRRORS,research:RESEARCH_COHORT,controls:CONTROL_COHORT});for(const e of envelopes)acceptEnvelope(e);
 const record={schemaVersion:3,eventId:id,webhookId:payload?.webhookId??null,provider:"ALCHEMY",transport:"ADDRESS_ACTIVITY_WEBHOOK",network:payload?.network??payload?.event?.network??null,receivedAt,providerCreatedAt:payload?.createdAt??null,signatureVerified:verified,bootstrapTest:bootstrap,eligibleForProspectiveAlpha:verified,rawBytes:raw.length,rawSha256:crypto.createHash("sha256").update(raw).digest("hex"),manifestHash:SUBSCRIPTION_MANIFEST_HASH,envelopeIds:envelopes.map(e=>e.eventId),payload};appendRecord(record);console.log(JSON.stringify({level:"info",event:"shark_scout_alchemy_webhook_received",eventId:id,verified,bootstrap,bytes:raw.length,envelopes:envelopes.length,manifestHash:SUBSCRIPTION_MANIFEST_HASH}));res.status(200).json({ok:true,eventId:id,envelopes:envelopes.length});
});
app.use(express.json({limit:"256kb"}));app.get("/",(_req,res:Response)=>res.json({ok:true,service:"shark-scout-alchemy-ab",version:VERSION,endpoints:["/health","/prospective/status","/webhooks/alchemy/address-activity"]}));
ensureDataDir();persistState();startWss();if(reconciler){setTimeout(()=>void reconcileTick(),5000);setInterval(()=>void reconcileTick(),60000);}
app.listen(PORT,"0.0.0.0",()=>console.log(JSON.stringify({level:"info",event:"shark_scout_alchemy_ab_started",port:PORT,version:VERSION,signingKeyConfigured:Boolean(SIGNING_KEY),rpcConfigured:Boolean(RPC_URL),wssConfigured:Boolean(WSS_URL),dataDir:DATA_DIR,manifestHash:SUBSCRIPTION_MANIFEST_HASH})));
