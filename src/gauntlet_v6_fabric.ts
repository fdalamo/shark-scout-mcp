import { runWithCanonicalHistoryFabric } from "./canonical_history_fabric.js";
import { runGauntlet } from "./gauntlet_v6.js";

runWithCanonicalHistoryFabric("gauntlet",()=>runGauntlet()).catch(e=>{console.error(JSON.stringify({event:"shark_scout_gauntlet_fabric_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
