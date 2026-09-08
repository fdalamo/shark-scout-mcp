import assert from "node:assert/strict";
import { replayEnhancedRows, USDC } from "./replay_core.js";
import { compareCanonicalPriority } from "./canonical_priority.js";

const W="Wallet111111111111111111111111111111111111";
const T="Token1111111111111111111111111111111111111";
function tb(mint:string,ui:number,decimals=6){return{userAccount:W,mint,rawTokenAmount:{tokenAmount:String(Math.round(ui*10**decimals)),decimals}};}
function tx(signature:string,timestamp:number,native:number,changes:any[],fee=5000){return{type:"SWAP",signature,timestamp,fee,feePayer:W,accountData:[{account:W,nativeBalanceChange:native,tokenBalanceChanges:changes}]};}

// Fee-neutralized SOL buy/sell: 1 SOL -> token -> 2 SOL.
const solRows=[tx("buy",1,-1_000_005_000,[tb(T,100)]),tx("sell",2,1_999_995_000,[tb(T,-100)])];
const a=replayEnhancedRows(solRows,W);
assert.equal(a.trusted.trades,1);
assert.ok(a.trusted.netSol!==null&&a.trusted.netSol>0);
assert.ok(Math.abs((a.roundTrips[0]?.sourceRoi??0)-1)<1e-9);

// Partial exits must allocate both cost basis and proceeds proportionally.
const partial=[tx("b",1,-1_000_005_000,[tb(T,100)]),tx("s1",2,499_995_000,[tb(T,-25)]),tx("s2",3,1_999_995_000,[tb(T,-75)])];
const b=replayEnhancedRows(partial,W);
assert.equal(b.trusted.trades,2);
assert.ok(Math.abs((b.roundTrips[0]?.buyQuote?.amount??0)-.25)<1e-9);
assert.ok(Math.abs((b.roundTrips[1]?.buyQuote?.amount??0)-.75)<1e-9);

// Same-stable quote is valid economics without pretending it is SOL.
const stable=[{type:"SWAP",signature:"ub",timestamp:1,fee:5000,feePayer:W,accountData:[{account:W,nativeBalanceChange:-5000,tokenBalanceChanges:[tb(USDC,-100),tb(T,100)]}]},{type:"SWAP",signature:"us",timestamp:2,fee:5000,feePayer:W,accountData:[{account:W,nativeBalanceChange:-5000,tokenBalanceChanges:[tb(USDC,120),tb(T,-100)]}]}];
const c=replayEnhancedRows(stable,W);
assert.equal(c.trusted.trades,1);
assert.ok(Math.abs((c.roundTrips[0]?.sourceRoi??0)-.2)<1e-9);

// Oversells never create artificial zero-cost profit.
const over=[tx("ob",1,-1_000_005_000,[tb(T,100)]),tx("os",2,1_999_995_000,[tb(T,-200)])];
const d=replayEnhancedRows(over,W);
assert.equal(d.roundTrips.length,1);
assert.equal(d.diagnostics.unmatchedSells,1);

// Token->token without a quote is structural activity, not exact follower PnL.
const T2="Token2222222222222222222222222222222222222";
const t2t=[{type:"SWAP",signature:"tt",timestamp:1,fee:5000,feePayer:W,accountData:[{account:W,nativeBalanceChange:-5000,tokenBalanceChanges:[tb(T,-10),tb(T2,20)]}]}];
const e=replayEnhancedRows(t2t,W);
assert.equal(e.trusted.trades,0);
assert.equal(e.diagnostics.tokenToToken,1);

// Extreme parser-derived returns are retained for audit but quarantined from trusted replay.
const extreme=[tx("xb",1,-0.001005*1e9,[tb(T,100)]),tx("xs",2,0.999995*1e9,[tb(T,-100)])];
const f=replayEnhancedRows(extreme,W);
assert.equal(f.raw.trades,1);
assert.equal(f.trusted.trades,0);
assert.equal(f.diagnostics.economicOutliers,1);

// Canonical scheduling: live/explicit priority beats backlog; within ordinary backlog,
// partially reconstructed wallets nearest completion beat zero-evidence wallets.
const base={contexts:2,coverage:.8,med:7200,canonicalComplete:false};
const ordered=[
  {address:"zero",closed:10,canonicalTrades:0,priorityTier:0,...base},
  {address:"near",closed:20,canonicalTrades:18,priorityTier:0,...base},
  {address:"live",closed:50,canonicalTrades:0,priorityTier:3,...base}
].sort(compareCanonicalPriority);
assert.deepEqual(ordered.map(x=>x.address),["live","near","zero"]);

console.log(JSON.stringify({event:"replay_core_selftest_passed",cases:7}));
