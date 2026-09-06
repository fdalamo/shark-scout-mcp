import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const KEY = process.env.ODIN_API_KEY?.trim();
const BASE = "https://api.odinbot.io";
const OUT = process.env.SCOUT_ODIN_SNAPSHOT_PATH || "/data/odin-config.json";
const TIMEOUT_MS = Math.max(3000, Math.min(60000, Number(process.env.REQUEST_TIMEOUT_MS || 25000)));

type AnyObj = Record<string, any>;

function stable(v: any): any {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
  return v;
}
function hash(v: any) { return createHash("sha256").update(JSON.stringify(stable(v))).digest("hex"); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function readJson(file: string) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function atomicSave(file: string, data: any) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); }
async function get(endpoint: string) {
  if (!KEY) throw new Error("ODIN_API_KEY_missing");
  let last: Error | null = null;
  for (let i = 0; i < 3; i++) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${BASE}${endpoint}`, { headers: { "x-api-key": KEY, accept: "application/json" }, signal: c.signal });
      const text = await r.text();
      if (r.ok) return text ? JSON.parse(text) : {};
      last = new Error(`${r.status}:${text.slice(0,180)}`);
      if (r.status !== 429 && r.status < 500) throw last;
      if (i < 2) await sleep((i + 1) * 900);
    } finally { clearTimeout(t); }
  }
  throw last || new Error("odin_request_failed");
}

export async function runOdinSync() {
  const startedAt = new Date().toISOString();
  if (!KEY) { console.log(JSON.stringify({ event: "shark_scout_odin_sync_skipped", reason: "ODIN_API_KEY_missing" })); return; }
  try {
    const previous = await readJson(OUT);
    const [controls, mirrorsBody] = await Promise.all([get("/v1/controls"), get("/v1/mirrors")]);
    const mirrors = Array.isArray(mirrorsBody?.mirrors) ? mirrorsBody.mirrors : [];
    mirrors.sort((a: AnyObj, b: AnyObj) => String(a?.address || "").localeCompare(String(b?.address || "")));
    const config = { controls, mirrors };
    const configHash = hash(config);
    const changed = Boolean(previous?.configHash && previous.configHash !== configHash);
    const snapshot = { schemaVersion: 1, fetchedAt: new Date().toISOString(), configHash, changedSincePrevious: changed, controls, mirrors };
    await atomicSave(OUT, snapshot);
    console.log(JSON.stringify({ event: "shark_scout_odin_sync_complete", startedAt, finishedAt: snapshot.fetchedAt, mirrorCount: mirrors.length, configHash: configHash.slice(0,12), changedSincePrevious: changed, allowBuysGlobal: controls?.allowBuys ?? null, onlyCopyNewPositionsGlobal: controls?.onlyCopyNewPositions ?? null, sellStrategyGlobal: controls?.sellStrategy ?? null }));
  } catch (e) {
    console.log(JSON.stringify({ event: "shark_scout_odin_sync_unknown", startedAt, error: e instanceof Error ? e.message : String(e) }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runOdinSync().catch(() => undefined);
