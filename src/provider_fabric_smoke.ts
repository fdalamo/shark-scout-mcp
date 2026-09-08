import { configuredRpcProviders, providerFabricEnabled, providerFabricReport, routedRpc } from "./provider_fabric.js";

async function main(){
  const configured=configuredRpcProviders();
  const results:any[]=[];
  if(providerFabricEnabled()){
    for(const provider of configured){
      try{const x=await routedRpc("getLatestBlockhash",[{commitment:"confirmed"}],{preferred:[provider as any]});results.push({provider,ok:true,blockhash:x.result?.value?.blockhash??null});}
      catch(e){results.push({provider,ok:false,error:String(e)});}
    }
  }
  console.log(JSON.stringify({event:"shark_scout_provider_fabric_smoke",enabled:providerFabricEnabled(),configured,results,telemetry:await providerFabricReport()}));
  if(providerFabricEnabled() && configured.length && results.some(x=>!x.ok))process.exitCode=2;
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_provider_fabric_smoke_failed",error:String(e)}));process.exitCode=1;});
