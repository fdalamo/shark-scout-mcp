import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.ALCHEMY_AB_DATA_DIR?.trim() || "/data";
const EVENT_LOG = path.join(DATA_DIR, "alchemy-prospective-events.jsonl");
const STATE_PATH = path.join(DATA_DIR, "alchemy-prospective-state.json");
const SIGNING_KEY = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY?.trim() || "";
const FOLLOWER_WALLET = process.env.SHARK_FOLLOWER_WALLET?.trim() || "9mVgPUP8eX37KooqxF4aN14UEpeQ2SywRK5rFiy2TSc9";
const LIVE_MIRRORS = new Set((process.env.SHARK_LIVE_MIRRORS ?? "").split(",").map(x => x.trim()).filter(Boolean));
const RESEARCH_COHORT = new Set((process.env.SHARK_RESEARCH_COHORT ?? "").split(",").map(x => x.trim()).filter(Boolean));
const CONTROL_COHORT = new Set((process.env.SHARK_CONTROL_COHORT ?? "").split(",").map(x => x.trim()).filter(Boolean));
const VERSION = "ab-1.0.0";

type State = {
  schemaVersion: number;
  startedAt: string;
  lastReceivedAt: string | null;
  lastVerifiedAt: string | null;
  received: number;
  verified: number;
  bootstrapAccepted: number;
  duplicates: number;
  rejectedSignature: number;
  malformed: number;
  bytes: number;
  uniqueEventIds: string[];
};

function initialState(): State {
  return { schemaVersion: 1, startedAt: new Date().toISOString(), lastReceivedAt: null, lastVerifiedAt: null, received: 0, verified: 0, bootstrapAccepted: 0, duplicates: 0, rejectedSignature: 0, malformed: 0, bytes: 0, uniqueEventIds: [] };
}

function loadState(): State {
  try { return { ...initialState(), ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) }; }
  catch { return initialState(); }
}

let state = loadState();
let writeQueue: Promise<void> = Promise.resolve();
const seen = new Set(state.uniqueEventIds);

function ensureDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function persistState() {
  state.uniqueEventIds = Array.from(seen).slice(-20000);
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function appendRecord(record: unknown) {
  writeQueue = writeQueue.then(async () => {
    ensureDataDir();
    fs.appendFileSync(EVENT_LOG, JSON.stringify(record) + "\n");
    persistState();
  }).catch((err) => console.error(JSON.stringify({ level: "error", event: "shark_scout_alchemy_persist_error", error: String(err) })));
}

function timingSafeHexEqual(a: string, b: string): boolean {
  try {
    const aa = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
  } catch { return false; }
}

function verifySignature(raw: Buffer, supplied: string): boolean {
  if (!SIGNING_KEY || !supplied) return false;
  const expected = crypto.createHmac("sha256", SIGNING_KEY).update(raw).digest("hex");
  return timingSafeHexEqual(expected, supplied);
}

function roleFor(address: string): string {
  if (address === FOLLOWER_WALLET) return "FOLLOWER";
  if (LIVE_MIRRORS.has(address)) return "LIVE_SOURCE";
  if (RESEARCH_COHORT.has(address)) return "RESEARCH";
  if (CONTROL_COHORT.has(address)) return "CONTROL";
  return "TRACKED_UNKNOWN";
}

function collectAddresses(payload: any): string[] {
  const out = new Set<string>();
  const visit = (v: any) => {
    if (!v) return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (typeof v !== "object") return;
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && /^(from|to|address|account|owner|wallet)/i.test(k) && val.length >= 32 && val.length <= 64) out.add(val);
      else if (typeof val === "object") visit(val);
    }
  };
  visit(payload?.event ?? payload);
  return [...out];
}

function eventId(payload: any, raw: Buffer): string {
  return String(payload?.id || payload?.event?.signature || payload?.signature || crypto.createHash("sha256").update(raw).digest("hex"));
}

const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "shark-scout-alchemy-ab", version: VERSION, signingKeyConfigured: Boolean(SIGNING_KEY), persistence: DATA_DIR, received: state.received, verified: state.verified, duplicates: state.duplicates, time: new Date().toISOString() });
});

app.get("/prospective/status", (_req, res) => {
  res.json({ ok: true, version: VERSION, state: { ...state, uniqueEventIds: undefined }, manifest: { followerConfigured: Boolean(FOLLOWER_WALLET), liveMirrorCount: LIVE_MIRRORS.size, researchCount: RESEARCH_COHORT.size, controlCount: CONTROL_COHORT.size }, prospectiveEligibility: SIGNING_KEY ? "VERIFIED_ONLY" : "BOOTSTRAP_TEST_ONLY" });
});

app.post("/webhooks/alchemy/address-activity", express.raw({ type: "application/json", limit: "1mb" }), (req: Request, res: Response) => {
  const receivedAt = new Date().toISOString();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
  const suppliedSignature = String(req.header("x-alchemy-signature") ?? "");
  const verified = verifySignature(raw, suppliedSignature);
  const bootstrap = !SIGNING_KEY;

  state.received += 1;
  state.bytes += raw.length;
  state.lastReceivedAt = receivedAt;

  if (!bootstrap && !verified) {
    state.rejectedSignature += 1;
    persistState();
    console.warn(JSON.stringify({ level: "warn", event: "shark_scout_alchemy_webhook_rejected", reason: "signature", receivedAt, bytes: raw.length }));
    res.status(403).json({ ok: false });
    return;
  }

  let payload: any;
  try { payload = JSON.parse(raw.toString("utf8")); }
  catch {
    state.malformed += 1;
    persistState();
    res.status(400).json({ ok: false });
    return;
  }

  const id = eventId(payload, raw);
  if (seen.has(id)) {
    state.duplicates += 1;
    persistState();
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }
  seen.add(id);
  if (verified) { state.verified += 1; state.lastVerifiedAt = receivedAt; }
  if (bootstrap) state.bootstrapAccepted += 1;

  const addresses = collectAddresses(payload);
  const record = {
    schemaVersion: 1,
    eventId: id,
    webhookId: payload?.webhookId ?? null,
    provider: "ALCHEMY",
    transport: "ADDRESS_ACTIVITY_WEBHOOK",
    network: payload?.network ?? payload?.event?.network ?? null,
    receivedAt,
    providerCreatedAt: payload?.createdAt ?? null,
    signatureVerified: verified,
    bootstrapTest: bootstrap,
    eligibleForProspectiveAlpha: verified,
    rawBytes: raw.length,
    rawSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    addresses: addresses.map(address => ({ address, role: roleFor(address) })),
    activityCount: Array.isArray(payload?.event?.activity) ? payload.event.activity.length : Array.isArray(payload?.activity) ? payload.activity.length : null,
    payload
  };
  appendRecord(record);
  console.log(JSON.stringify({ level: "info", event: "shark_scout_alchemy_webhook_received", eventId: id, verified, bootstrap, bytes: raw.length, addresses: record.addresses, activityCount: record.activityCount }));
  res.status(200).json({ ok: true, eventId: id });
});

app.use(express.json({ limit: "256kb" }));
app.get("/", (_req, res: Response) => res.json({ ok: true, service: "shark-scout-alchemy-ab", version: VERSION, endpoints: ["/health", "/prospective/status", "/webhooks/alchemy/address-activity"] }));

ensureDataDir();
persistState();
app.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ level: "info", event: "shark_scout_alchemy_ab_started", port: PORT, version: VERSION, signingKeyConfigured: Boolean(SIGNING_KEY), dataDir: DATA_DIR })));
