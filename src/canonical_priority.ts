export type CanonicalPriorityInput={
  address:string;
  closed:number;
  canonicalTrades:number;
  canonicalComplete:boolean;
  contexts:number;
  coverage:number;
  med:number;
  priorityTier:number;
};

export type CanonicalPriorityMetrics={
  deficit:number;
  canonicalCoverage:number;
  hasCanonicalEvidence:boolean;
};

export function canonicalPriorityMetrics(x:CanonicalPriorityInput):CanonicalPriorityMetrics{
  const closed=Math.max(0,Number(x.closed)||0),trades=Math.max(0,Number(x.canonicalTrades)||0);
  return{
    deficit:Math.max(0,closed-trades),
    canonicalCoverage:closed>0?Math.min(1,trades/closed):0,
    hasCanonicalEvidence:trades>0
  };
}

/**
 * Production objective: finish decision-useful canonical evidence before widening work.
 * Explicit/live priorities always win. Among ordinary incomplete wallets, finish partially
 * reconstructed wallets with the smallest remaining deficit/highest coverage first.
 * Completed wallets remain behind incomplete wallets because replay is monotonic.
 */
export function compareCanonicalPriority(a:CanonicalPriorityInput,b:CanonicalPriorityInput):number{
  if(b.priorityTier!==a.priorityTier)return b.priorityTier-a.priorityTier;
  if(a.canonicalComplete!==b.canonicalComplete)return Number(a.canonicalComplete)-Number(b.canonicalComplete);
  const am=canonicalPriorityMetrics(a),bm=canonicalPriorityMetrics(b);
  if(am.hasCanonicalEvidence!==bm.hasCanonicalEvidence)return Number(bm.hasCanonicalEvidence)-Number(am.hasCanonicalEvidence);
  if(am.deficit!==bm.deficit)return am.deficit-bm.deficit;
  if(am.canonicalCoverage!==bm.canonicalCoverage)return bm.canonicalCoverage-am.canonicalCoverage;
  if(b.contexts!==a.contexts)return b.contexts-a.contexts;
  if(b.coverage!==a.coverage)return b.coverage-a.coverage;
  if(b.med!==a.med)return b.med-a.med;
  if(b.closed!==a.closed)return b.closed-a.closed;
  return a.address.localeCompare(b.address);
}
