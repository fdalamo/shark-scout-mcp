import path from "node:path";
import { manifestHash } from "./prospective_ab_lab.js";
import { PackageDGovernance } from "./package_d_governance.js";

const DATA_DIR=process.env.ALCHEMY_AB_DATA_DIR?.trim()||"/data";
const FOLLOWER_WALLET=process.env.SHARK_FOLLOWER_WALLET?.trim()||"9mVgPUP8eX37KooqxF4aN14UEpeQ2SywRK5rFiy2TSc9";
const LIVE_MIRRORS=new Set((process.env.SHARK_LIVE_MIRRORS??"").split(",").map(x=>x.trim()).filter(Boolean));
const RESEARCH_COHORT=new Set((process.env.SHARK_RESEARCH_COHORT??"").split(",").map(x=>x.trim()).filter(Boolean));
const CONTROL_COHORT=new Set((process.env.SHARK_CONTROL_COHORT??"").split(",").map(x=>x.trim()).filter(Boolean));
const subscriptionManifest={follower:FOLLOWER_WALLET,live:[...LIVE_MIRRORS].sort(),research:[...RESEARCH_COHORT].sort(),controls:[...CONTROL_COHORT].sort()};
const MANIFEST_HASH=manifestHash(subscriptionManifest);
const root=path.join(DATA_DIR,"prospective-ab");
const governance=new PackageDGovernance(root,MANIFEST_HASH,LIVE_MIRRORS,RESEARCH_COHORT,CONTROL_COHORT);
const everyMs=Math.max(60000,Number(process.env.PACKAGE_D_EVALUATE_MS??300000));

function run(){try{const s=governance.snapshot();console.log(JSON.stringify({level:"info",event:"shark_scout_package_d_evaluated",at:s.at,policyHash:s.policyHash,manifestHash:s.manifestHash,summary:s.summary,controls:s.controls,advisoryOnly:true}));}catch(err){console.error(JSON.stringify({level:"error",event:"shark_scout_package_d_error",error:String(err)}));}}

run();setInterval(run,everyMs);
console.log(JSON.stringify({level:"info",event:"shark_scout_package_d_started",dataDir:DATA_DIR,manifestHash:MANIFEST_HASH,evaluateEveryMs:everyMs,advisoryOnly:true,odinMutation:false,capitalMutation:false,mirrorMutation:false}));
