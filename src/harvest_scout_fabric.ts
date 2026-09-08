import http from "node:http";
import { providerFabricEnabled, providerFabricReport, routedRpc } from "./provider_fabric.js";

function readBody(req:http.IncomingMessage){return new Promise<string>((resolve,reject)=>{let body="";req.setEncoding("utf8");req.on("data",chunk=>{body+=chunk;if(body.length>1_000_000){reject(new Error("rpc_proxy_body_too_large"));req.destroy();}});req.on("end",()=>resolve(body));req.on("error",reject);});}

async function startFabricProxy(){
  const server=http.createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.method!=="POST"){res.statusCode=405;res.end(JSON.stringify({error:"method_not_allowed"}));return;}
    let id:unknown=null;
    try{
      const raw=await readBody(req);
      const body=raw?JSON.parse(raw):{};
      id=body?.id??null;
      if(typeof body?.method!=="string")throw new Error("invalid_rpc_method");
      const params=Array.isArray(body?.params)?body.params:[];
      const routed=await routedRpc(body.method,params);
      res.statusCode=200;
      res.end(JSON.stringify({jsonrpc:"2.0",id,result:routed.result}));
    }catch(e){
      console.error(JSON.stringify({event:"shark_scout_provider_fabric_proxy_error",error:String(e).slice(0,500)}));
      res.statusCode=502;
      res.end(JSON.stringify({jsonrpc:"2.0",id,error:{code:-32000,message:"provider fabric RPC failed"}}));
    }
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
  const address=server.address();
  if(!address||typeof address==="string")throw new Error("provider_fabric_proxy_no_port");
  return {server,url:`http://127.0.0.1:${address.port}`};
}

async function main(){
  let server:http.Server|undefined;
  if(providerFabricEnabled()){
    const proxy=await startFabricProxy();
    server=proxy.server;
    // provider_fabric captured the original provider URLs before this override. Only the
    // harvest_scout child module sees the local endpoint, so Helius-specific REST APIs stay direct.
    process.env.SOLANA_RPC_URL=proxy.url;
    console.log(JSON.stringify({event:"shark_scout_provider_fabric_proxy_started"}));
  }
  try{
    const {runScoutHarvest}=await import("./harvest_scout.js");
    await runScoutHarvest();
  } finally {
    if(providerFabricEnabled())console.log(JSON.stringify(await providerFabricReport()));
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  }
}

main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_harvest_fabric_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
