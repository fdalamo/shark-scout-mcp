const MAX_WRITE_BYTES=Math.max(8_192,Math.min(131_072,Number(process.env.SCOUT_MAX_LOG_WRITE_BYTES||32_768)));
const PATCH="0.52.4-log-guard";

type WriteFn=typeof process.stdout.write;

function originalEvent(text:string){
  const m=text.match(/\"event\"\s*:\s*\"([^\"]{1,120})\"/);
  return m?.[1]||null;
}

function guardedWrite(original:WriteFn,stream:"stdout"|"stderr"):WriteFn{
  return function(this:NodeJS.WriteStream,chunk:any,...args:any[]):boolean{
    try{
      const bytes=Buffer.isBuffer(chunk)?chunk.length:Buffer.byteLength(String(chunk));
      if(bytes>MAX_WRITE_BYTES){
        const text=Buffer.isBuffer(chunk)?chunk.toString("utf8",0,Math.min(chunk.length,4096)):String(chunk).slice(0,4096);
        const replacement=JSON.stringify({event:"shark_scout_log_payload_suppressed",patch:PATCH,stream,originalEvent:originalEvent(text),originalBytes:bytes,maxWriteBytes:MAX_WRITE_BYTES,at:new Date().toISOString()})+"\n";
        return (original as any).call(this,replacement,...args);
      }
    }catch{}
    return (original as any).call(this,chunk,...args);
  } as WriteFn;
}

process.stdout.write=guardedWrite(process.stdout.write.bind(process.stdout) as WriteFn,"stdout");
process.stderr.write=guardedWrite(process.stderr.write.bind(process.stderr) as WriteFn,"stderr");
