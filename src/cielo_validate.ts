import { promises as fs } from "node:fs";
import path from "node:path";

const KEY = process.env.CIELO_API_KEY?.trim();
const BASE = "https://feed-api.cielo.finance/api/v1";
const REPORT_PATH = process.env.SCOUT_GAUNTLET_PATH || "/data/latest-gauntlet.json";
const CHECKPOINT_PATH = process.env.SCOUT_GAUNTLET_STATE_PATH || "/data/gauntlet-state.json";
const CACHE_PATH = process.env.SCOUT_CIELO_VALIDATION_CACHE_PATH || "/data/cielo-validation-cache.json";
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 25000), 3000, 60000);
const CACHE_TTL_MS = clamp(Number(process.env.CIELO_VALIDATION_HOURS || 12), 1, 72) * 3600_000;

type AnyObj = Record<string, any>;
type GateStatus = "PASS" | "SIGNAL_ONLY" | "REJECT" | "UNKNOWN";
type Cache = { version: 1; wallets: Record<string, { fetchedAt: string; trading: any; tokens?: any }> };

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function num(v: any): number | null { if (typeof v === "number" && Number.isFinite(v)) return v; if (typeof v === "string") { const n = Number(v.replace(/[,$%]/g, "")); return Number.isFinite(n) ? n : null; } return null; }
function rate(v: number | null) { if (v == null) return null; return v > 1 ? v / 100 : v; }
function duration(v: any): number | null { if (typeof v === "number" && Number.isFinite(v)) return v; if (typeof v !== "string") return null; const s = v.toLowerCase(); let total = 0, hit = false; for (const m of s.matchAll(/([\d.]+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/g)) { const n = Number(m[1]); if (!Number.isFinite(n)) continue; hit = true; const u = m[2]; if (u.startsWith("d")) total += n * 86400; else if (u.startsWith("h")) total += n * 3600; else if (u.startsWith("m")) total += n * 60; else total += n; } return hit ? total : num(v); }
function entries(x: any, prefix = ""): Array<{ k: string; v: any }> { const out: Array<{ k: string; v: any }> = []; if (Array.isArray(x)) { x.forEach((v, i) => out.push(...entries(v, `${prefix}[${i}]`))); return out; } if (x && typeof x === "object") { for (const [k, v] of Object.entries(x)) { const p = prefix ? `${prefix}.${k}` : k; if (v && typeof v === "object") out.push(...entries(v, p)); else out.push({ k: p.toLowerCase(), v }); } } return out; }
function pick(x: any, patterns: RegExp[], parser: (v: any) => number | null = num) { for (const e of entries(x)) if (patterns.some(p => p.test(e.k))) { const n = parser(e.v); if (n != null) return n; } return null; }
function tokenRows(x: any): any[] { if (Array.isArray(x)) return x; for (const k of ["data", "items", "tokens", "results"]) if (Array.isArray(x?.[k])) return x[k]; return []; }
function pnlOf(row: any) { return pick(row, [/realized.*pnl/, /(^|\.)pnl$/]); }
function summarizeTrading(trading: any) {
  const winRate = rate(pick(trading, [/(^|\.)win[_-]?rate$/, /token[_-]?winrate$/, /(^|\.)winrate$/]));
  let medianHoldSeconds = pick(trading, [/median.*hold.*seconds/, /median.*holding.*seconds/]);
  if (medianHoldSeconds == null) medianHoldSeconds = pick(trading, [/median.*hold/, /median.*holding/], duration);
  const tokensTraded = pick(trading, [/(^|\.)(tokens[_-]?traded|token[_-]?count|total[_-]?tokens)$/]);
  const realizedPnl = pick(trading, [/realized.*pnl/, /total.*pnl/]);
  const realizedRoi = rate(pick(trading, [/realized.*roi/, /(^|\.)roi$/]));
  return { winRate, medianHoldSeconds, tokensTraded, realizedPnl, realizedRoi };
}
function summarizeTokens(tokens: any) { const rows = tokenRows(tokens), positives = rows.map(pnlOf).filter((v): v is number => v != null && v > 0); const totalPositive = positives.reduce((a, b) => a + b, 0), maxPositive = positives.length ? Math.max(...positives) : 0; return { tokenRows: rows.length, largestWinnerShare: totalPositive > 0 ? maxPositive / totalPositive : null }; }
async function atomicSave(file: string, data: any) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); }
async function cielo(pathname: string, query: string) { if (!KEY) throw new Error("CIELO_API_KEY_missing"); for (let a = 0; a < 3; a++) { const c = new AbortController(), t = setTimeout(() => c.abort(), TIMEOUT_MS); try { const r = await fetch(`${BASE}${pathname}${query}`, { headers: { "X-API-KEY": KEY }, signal: c.signal }); const text = await r.text(); if (r.status === 202) { if (a < 2) { await sleep(10000); continue; } throw new Error("202:data_not_ready"); } if (!r.ok) throw new Error(`${r.status}:${text.slice(0, 180)}`); return text ? JSON.parse(text) : {}; } finally { clearTimeout(t); } } throw new Error("cielo_request_failed"); }

function validate(candidate: any, s: any): { status: GateStatus; reasons: string[] } {
  const reasons: string[] = []; let status: GateStatus = "PASS";
  const rank: Record<GateStatus, number> = { UNKNOWN: 0, PASS: 1, SIGNAL_ONLY: 2, REJECT: 3 };
  const downgrade = (next: GateStatus) => { if (rank[next] > rank[status]) status = next; };
  const scoutMed = num(candidate?.hold?.medianHoldSeconds), closed = num(candidate?.hold?.closedHolds) || 0, externalMed = s.medianHoldSeconds as number | null, wr = s.winRate as number | null, tok = s.tokensTraded as number | null;
  if (externalMed == null && wr == null && tok == null) return { status: "UNKNOWN", reasons: ["cielo_fields_unparsed"] };
  if (externalMed != null && externalMed < 600) { downgrade("REJECT"); reasons.push("cielo_median_hold_under_10m"); }
  else if (externalMed != null && externalMed < 3600) { downgrade("SIGNAL_ONLY"); reasons.push("cielo_median_hold_under_1h"); }
  else if (externalMed != null && externalMed < 21600) { downgrade("SIGNAL_ONLY"); reasons.push("cielo_median_hold_under_6h"); }
  if (wr != null && tok != null && tok >= 20 && wr < .20) { downgrade("REJECT"); reasons.push("cielo_win_rate_under_20pct"); }
  else if (wr != null && tok != null && tok >= 20 && wr < .30) { downgrade("SIGNAL_ONLY"); reasons.push("cielo_win_rate_under_30pct"); }
  if (scoutMed != null && externalMed != null && externalMed > 0) { const ratio = Math.max(scoutMed / externalMed, externalMed / scoutMed); if (ratio >= 3) { downgrade("SIGNAL_ONLY"); reasons.push(`hold_median_discrepancy_${ratio.toFixed(1)}x`); } }
  if (tok != null && tok >= 20 && closed > 0) { const coverage = closed / tok; if (coverage < .25) { downgrade("SIGNAL_ONLY"); reasons.push(`reconstructed_sample_coverage_${(coverage * 100).toFixed(1)}pct`); } }
  if (s.largestWinnerShare != null && s.largestWinnerShare > .75) { downgrade("REJECT"); reasons.push(`cielo_largest_winner_share_${(s.largestWinnerShare * 100).toFixed(0)}pct`); }
  else if (s.largestWinnerShare != null && s.largestWinnerShare > .60) { downgrade("SIGNAL_ONLY"); reasons.push(`cielo_largest_winner_share_${(s.largestWinnerShare * 100).toFixed(0)}pct`); }
  if (!reasons.length) reasons.push("cielo_external_validation_pass");
  return { status, reasons };
}

export async function runCieloValidation() {
  const startedAt = new Date().toISOString();
  if (!KEY) { console.log(JSON.stringify({ event: "shark_scout_cielo_validation_skipped", reason: "CIELO_API_KEY_missing" })); return; }
  let report: AnyObj, cp: AnyObj;
  try { report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8")); cp = JSON.parse(await fs.readFile(CHECKPOINT_PATH, "utf8")); } catch (e) { console.log(JSON.stringify({ event: "shark_scout_cielo_validation_skipped", reason: "gauntlet_files_unavailable", error: String(e) })); return; }
  const cache: Cache = await (async () => { try { const x = JSON.parse(await fs.readFile(CACHE_PATH, "utf8")); return { version: 1, wallets: x?.wallets || {} }; } catch { return { version: 1, wallets: {} }; } })();
  const candidates = Array.isArray(report.deepDive) ? report.deepDive : [], validations: any[] = [];
  let requests = 0, cacheHits = 0, estimatedCredits = 0, tokenPnlSkipped = 0;
  for (const c of candidates) {
    const address = String(c?.address || ""); if (!address) continue;
    try {
      const cached = cache.wallets[address], age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
      let trading: any;
      if (cached && Number.isFinite(age) && age < CACHE_TTL_MS) { trading = cached.trading; cacheHits++; }
      else { trading = await cielo(`/${address}/trading-stats`, "?days=30d"); requests++; estimatedCredits += 30; cache.wallets[address] = { fetchedAt: new Date().toISOString(), trading }; }
      let summary: any = summarizeTrading(trading), preliminary = validate(c, summary);
      if (preliminary.status === "PASS") {
        let tokens: any;
        const freshCached = cache.wallets[address], sameFresh = freshCached?.tokens && Number.isFinite(Date.now() - Date.parse(freshCached.fetchedAt)) && Date.now() - Date.parse(freshCached.fetchedAt) < CACHE_TTL_MS;
        if (sameFresh) { tokens = freshCached.tokens; cacheHits++; }
        else { tokens = await cielo(`/${address}/pnl/tokens`, "?timeframe=30d&chain=solana"); requests++; estimatedCredits += 5; cache.wallets[address].tokens = tokens; }
        summary = { ...summary, ...summarizeTokens(tokens) };
      } else tokenPnlSkipped++;
      const decision = validate(c, summary), external = { provider: "cielo", timeframe: "30d", checkedAt: new Date().toISOString(), ...summary, ...decision };
      validations.push({ address, ...external });
      const r = cp?.results?.[address]; if (r) { r.externalValidation = external; if (decision.status === "REJECT" || decision.status === "SIGNAL_ONLY") r.verdict = { status: decision.status, stage: "cielo_external_validation", reasons: [...(r.verdict?.reasons || []), ...decision.reasons] }; }
    } catch (e) { validations.push({ address, provider: "cielo", timeframe: "30d", status: "UNKNOWN", reasons: ["cielo_request_error"], error: String(e).slice(0, 220) }); }
  }
  await atomicSave(CACHE_PATH, cache);
  const current = Object.values(cp?.results || {}) as any[], counts = current.reduce((a: any, x: any) => { const s = x?.verdict?.status || "UNKNOWN"; a[s] = (a[s] || 0) + 1; return a; }, {});
  const stillDeep = current.filter(x => x?.verdict?.status === "DEEP_DIVE").sort((a, b) => (b?.replay?.twoPerDay?.stress50NetSol || -999) - (a?.replay?.twoPerDay?.stress50NetSol || -999));
  report.cieloValidation = { startedAt, finishedAt: new Date().toISOString(), candidatesChecked: validations.length, requests, cacheHits, estimatedCredits, tokenPnlSkipped, validations };
  report.deepDive = stillDeep.slice(0, 25); report.counts = counts; report.note = `${report.note || ""} Cielo 30D external validation is mandatory for DEEP_DIVE; trading-stats is cached and token PnL is fetched only for candidates that survive the behavioral gate.`.trim(); cp.updatedAt = new Date().toISOString();
  await atomicSave(CHECKPOINT_PATH, cp); await atomicSave(REPORT_PATH, report);
  console.log(JSON.stringify({ event: "shark_scout_cielo_validation_complete", startedAt, finishedAt: new Date().toISOString(), candidatesChecked: validations.length, requests, cacheHits, estimatedCredits, tokenPnlSkipped, counts, validations: validations.map(v => ({ address: v.address, status: v.status, medianHoldSeconds: v.medianHoldSeconds, winRate: v.winRate, tokensTraded: v.tokensTraded, realizedPnl: v.realizedPnl, realizedRoi: v.realizedRoi, largestWinnerShare: v.largestWinnerShare, reasons: v.reasons, error: v.error })) }));
}

if (import.meta.url === `file://${process.argv[1]}`) runCieloValidation().catch(e => { console.error(JSON.stringify({ event: "shark_scout_cielo_validation_failed", error: e instanceof Error ? e.message : String(e) })); process.exitCode = 0; });
