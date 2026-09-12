import assert from "node:assert/strict";
import { evaluateShadow, prospectiveMetrics, qualifiesHistorical } from "./candidate_engine.js";

const historicalCandidate={
  replay:{authoritative:true,trades:12,net:1.2,stress50:.5},
  sampleQuality:{risk:"LOW",discoveryContexts:3},
  medianHoldHours:2,
  canonicalOverlayStatus:"ODIN_PROSPECT",
  blockers:[]
};
const canonicalTrips=Array.from({length:12},(_,i)=>({mint:`M${i%4}`,buyTimestamp:1_700_000_000+i*7200,sellTimestamp:1_700_003_600+i*7200,followerNetSol:.02,stress50NetSol:.01}));
const hist=qualifiesHistorical(historicalCandidate,{canonicalReplay:{roundTrips:canonicalTrips},canonicalOverlay:{status:"ODIN_PROSPECT"}});
assert.equal(hist.ready,true,"expected strong canonical candidate to pass historical guards");

const bad=qualifiesHistorical({...historicalCandidate,sampleQuality:{risk:"HIGH",discoveryContexts:1}},{canonicalReplay:{roundTrips:canonicalTrips},canonicalOverlay:{status:"ODIN_PROSPECT"}});
assert.equal(bad.ready,false,"high-risk/single-context candidate must not pass");
assert.ok(bad.reasons.includes("sample_risk_high"));
assert.ok(bad.reasons.includes("discovery_contexts_lt_2"));

const start="2026-09-01T00:00:00.000Z";
const startSec=Date.parse(start)/1000;
const forward=Array.from({length:7},(_,i)=>({mint:`F${i%3}`,buyTimestamp:startSec+3600+i*7200,sellTimestamp:startSec+5400+i*7200,followerNetSol:.01,stress50NetSol:.005}));
const old=[{mint:"OLD",buyTimestamp:startSec-86400,sellTimestamp:startSec-80000,followerNetSol:5,stress50NetSol:5}];
const metrics=prospectiveMetrics([...old,...forward],start);
assert.equal(metrics.closed,7,"pre-freeze trade must not leak into shadow sample");
assert.equal(metrics.distinctMints,3);
assert.ok(metrics.netSol>0&&metrics.stress50NetSol>0);

const ready=evaluateShadow(start,metrics,new Date("2026-09-04T12:00:00.000Z"));
assert.equal(ready.stage,"ODIN_TRIAL_READY","7 closes / 3 mints / >72h with positive economics should pass shadow");

const losing=prospectiveMetrics(forward.map((x,i)=>({...x,followerNetSol:i===0?.01:-.03,stress50NetSol:i===0?.005:-.02})),start);
const fail=evaluateShadow(start,losing,new Date("2026-09-04T12:00:00.000Z"));
assert.equal(fail.stage,"SHADOW_FAIL","completed forward sample with negative economics must fail");

console.log(JSON.stringify({event:"candidate_engine_selftest_passed",tests:7}));
