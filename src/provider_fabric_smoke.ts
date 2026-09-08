import { configuredRpcProviders, providerFabricReport, routedRpc } from "./provider_fabric.js";

const SMOKE_ENABLED = /^(1|true|yes)$/i.test(process.env.PROVIDER_FABRIC_SMOKE_ENABLED || "false");

async function main(){
  const configured=configuredRpcProviders();
  const results:any[]=[];
  if(SMOKE_ENABLED){
    for(const provider of configured){
      try{
        // Smoke testing intentionally bypasses the production-routing gate only for
        // this process. The router still remains disabled for harvest consumers.
        process.env.PROVIDER_FABRIC_ENABLED = "true";
        const x=await routedRpc("getLatestBlockhash",[{commitment:"confirmed"}],{preferred:[provider as any]});
        results.push({provider,ok:true,blockhash:x.result?.value?.blockhash??null});
      } catch(e){
        results.push({provider,ok:false,error:String(e)});
      }
    }
  }
  console.log(JSON.stringify({event:"shark_scout_provider_fabric_smoke",smokeEnabled:SMOKE_ENABLED,configured,results,telemetry:await providerFabricReport()}));
  if(SMOKE_ENABLED && configured.length && results.some(x=>!x.ok))process.exitCode=2;
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_provider_fabric_smoke_failed",error:String(e)}));process.exitCode=1;});
