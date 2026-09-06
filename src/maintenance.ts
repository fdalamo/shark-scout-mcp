import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || "/data";
const CACHE_DIR = process.env.SCOUT_HELIUS_CACHE_DIR || path.join(ROOT, "helius-cache-v2");
const STATE_PATH = process.env.SCOUT_STATE_PATH || path.join(ROOT, "shark-state.json");
const KEEP_HOURS = clamp(Number(process.env.HARVEST_CACHE_KEEP_HOURS || 12), 3, 72);
const MAX_CACHE_FILES = clamp(Number(process.env.HARVEST_CACHE_MAX_WALLETS || 1200), 200, 5000);
const TMP_KEEP_HOURS = clamp(Number(process.env.SCOUT_TMP_KEEP_HOURS || 2), 1, 24);
const REJECT_COMPACT_HOURS = clamp(Number(process.env.SCOUT_REJECT_COMPACT_HOURS || 168), 24, 720);

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min)); }
async function sizeOf(file: string) { try { return (await fs.stat(file)).size; } catch { return 0; } }
async function unlink(file: string) { try { const b = await sizeOf(file); await fs.unlink(file); return b; } catch { return 0; } }
async function atomicSave(file: string, data: any) { const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); }

async function pruneWalletCache() {
  try {
    const files = (await fs.readdir(CACHE_DIR)).filter(f => f.endsWith(".json"));
    const rows: Array<{ p: string; m: number; s: number }> = [];
    for (const f of files) { try { const p = path.join(CACHE_DIR, f), st = await fs.stat(p); rows.push({ p, m: st.mtimeMs, s: st.size }); } catch {} }
    rows.sort((a,b) => b.m - a.m);
    const cutoff = Date.now() - KEEP_HOURS * 3600_000;
    let removed = 0, bytes = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].m < cutoff || i >= MAX_CACHE_FILES) { bytes += await unlink(rows[i].p); removed++; }
    return { removed, bytes, remaining: Math.max(0, rows.length - removed) };
  } catch { return { removed: 0, bytes: 0, remaining: 0 }; }
}

async function pruneTemps() {
  let removed = 0, bytes = 0;
  try {
    const cutoff = Date.now() - TMP_KEEP_HOURS * 3600_000;
    for (const f of await fs.readdir(ROOT)) {
      if (!f.includes(".tmp")) continue;
      try { const p = path.join(ROOT, f), st = await fs.stat(p); if (st.mtimeMs < cutoff) { bytes += await unlink(p); removed++; } } catch {}
    }
  } catch {}
  return { removed, bytes };
}

async function removeLegacy() {
  const targets = [process.env.SCOUT_HELIUS_CACHE_PATH || path.join(ROOT, "helius-cache.json")];
  let removed = 0, bytes = 0;
  for (const p of targets) { try { const st = await fs.stat(p); if (st.isFile()) { bytes += await unlink(p); removed++; } } catch {} }
  return { removed, bytes };
}

async function compactRejectedState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
    const wallets = state?.wallets || {}; const cutoff = Date.now() - REJECT_COMPACT_HOURS * 3600_000;
    let compacted = 0;
    for (const [address, w] of Object.entries(wallets) as Array<[string, any]>) {
      if (w?.status !== "REJECTED") continue;
      const t = Date.parse(w?.lastSeen || w?.firstSeen || ""); if (!Number.isFinite(t) || t > cutoff) continue;
      wallets[address] = { address, firstSeen: w.firstSeen, lastSeen: w.lastSeen, rediscoveryCount: w.rediscoveryCount || 1, tokens: Array.isArray(w.tokens) ? w.tokens.slice(-8) : [], providers: Array.isArray(w.providers) ? w.providers : [], lanes: [], tags: [], status: "REJECTED", rejectionReason: w.rejectionReason || "rejected" };
      compacted++;
    }
    if (Array.isArray(state.runs) && state.runs.length > 200) state.runs = state.runs.slice(-200);
    if (compacted) await atomicSave(STATE_PATH, state);
    return compacted;
  } catch { return 0; }
}

async function disk() {
  try { const s = await fs.statfs(ROOT); const total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize); return { totalBytes: total, freeBytes: free, usedPct: total > 0 ? (total - free) / total : null }; }
  catch { return { totalBytes: null, freeBytes: null, usedPct: null }; }
}

export async function runMaintenance() {
  const before = await disk();
  const [cache, temps, legacy, compactedRejected] = await Promise.all([pruneWalletCache(), pruneTemps(), removeLegacy(), compactRejectedState()]);
  const after = await disk();
  console.log(JSON.stringify({ event: "shark_scout_maintenance_complete", cache, temps, legacy, compactedRejected, before, after, bytesFreedApprox: cache.bytes + temps.bytes + legacy.bytes }));
}

if (import.meta.url === `file://${process.argv[1]}`) runMaintenance().catch(e => console.log(JSON.stringify({ event: "shark_scout_maintenance_unknown", error: String(e) })));
