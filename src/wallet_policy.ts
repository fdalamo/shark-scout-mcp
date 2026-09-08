export const IAN="ianCETBFexGgK8TA3gSLeAaNiLMsJPgUN1H44jhxQtB";
export const SIX_MZ="6mzEFZ458A6qcaQLgtBuYYaGJ1qN5tz2Wsr6PC1fLFzx";

export type WalletPolicy={
  tradeSizeSol:number;
  hourlyCap:number;
  dailyCap:number;
  tokenDayCap:number;
  tokenWeekCap:number;
  newPositionOnly:boolean;
  minMarketCapUsd:number|null;
  maxMarketCapUsd:number|null;
  sellMode:"SOURCE_PROPORTIONAL";
  shadowDailyCaps:number[];
};

const DEFAULT_POLICY:WalletPolicy={
  tradeSizeSol:.075,
  hourlyCap:1,
  dailyCap:1,
  tokenDayCap:1,
  tokenWeekCap:1,
  newPositionOnly:true,
  minMarketCapUsd:null,
  maxMarketCapUsd:null,
  sellMode:"SOURCE_PROPORTIONAL",
  shadowDailyCaps:[2,3],
};

const REGISTRY:Record<string,WalletPolicy>={
  [IAN]:{...DEFAULT_POLICY,hourlyCap:1,dailyCap:1,minMarketCapUsd:100000,shadowDailyCaps:[2,3]},
  [SIX_MZ]:{...DEFAULT_POLICY,hourlyCap:2,dailyCap:2,minMarketCapUsd:500000,shadowDailyCaps:[3]},
};

export function walletPolicy(address:string):WalletPolicy{
  return {...(REGISTRY[address]||DEFAULT_POLICY),shadowDailyCaps:[...(REGISTRY[address]?.shadowDailyCaps||DEFAULT_POLICY.shadowDailyCaps)]};
}

export function researchFocusWallets():string[]{return [IAN,SIX_MZ];}

export function policyFingerprint(address:string):string{
  const p=walletPolicy(address);
  return [address,p.tradeSizeSol,p.hourlyCap,p.dailyCap,p.tokenDayCap,p.tokenWeekCap,p.newPositionOnly?1:0,p.minMarketCapUsd??"",p.maxMarketCapUsd??"",p.sellMode,p.shadowDailyCaps.join(",")].join("|");
}
