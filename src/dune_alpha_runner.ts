import { promises as fs } from "node:fs";
import path from "node:path";
import { runDuneAlphaDiscovery } from "./dune_alpha_discovery.js";

const STATE_PATH = process.env.SCOUT_STATE_PATH || "/data/shark-state.json";
async function readJson(file: string, fallback: any) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function atomicSave(file: string, data: any) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); }

async function main() {
  const startedAt = new Date().toISOString();
  const state = await readJson(STATE_PATH, { schemaVersion: 6, createdAt: startedAt, updatedAt: startedAt, wallets: {}, tokens: {}, runs: [] });
  const telemetry = await runDuneAlphaDiscovery(state);
  state.updatedAt = new Date().toISOString();
  await atomicSave(STATE_PATH, state);
  console.log(JSON.stringify(telemetry));
}

main().catch(e => { console.error(JSON.stringify({ event: "shark_scout_dune_alpha_failed", error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
