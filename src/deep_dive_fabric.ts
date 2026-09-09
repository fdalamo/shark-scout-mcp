import { runWithCanonicalHistoryFabric } from "./canonical_history_fabric.js";
import { runDeepDiveReinvestigation } from "./deep_dive_reinvestigate.js";

runWithCanonicalHistoryFabric("deep_dive",()=>runDeepDiveReinvestigation()).catch(e=>{console.error(JSON.stringify({event:"shark_scout_deep_dive_fabric_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
