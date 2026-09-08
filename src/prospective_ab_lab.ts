import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Transport = "alchemy_webhook" | "alchemy_wss" | "tracker_wss" | "rpc_reconcile";
export type Role = "FOLLOWER" | "LIVE_SOURCE" | "RESEARCH" | "CONTROL" | "TRACKED_UNKNOWN";

export type EventEnvelope = {
  schemaVersion: 2;
  eventId: string;
  provider: string;
  transport: Transport;
  receivedAt: string;
  providerCreatedAt: string | null;
  wallet: string | null;
  role: Role;
  signature: string | null;
  slot: number | null;
  blockTime: number | null;
  eventType: string;
  rawPayloadHash: string;
  sourceEventId: string;
  prospectiveEligible: boolean;
};

export type CandidateEpoch = {
  schemaVersion: 1;
  candidateEpochId: string;
  wallet: string;
  role: "RESEARCH" | "CONTROL" | "LIVE_SOURCE";
  selectionTime: string;
  selectionCommit: string;
  gauntletVersion: string;
  filters: Record<string, unknown>;
  odinSettings: Record<string, unknown>;
  historicalDatasetHash: string;
  historicalMetrics: Record<string, unknown>;
  cohortManifestHash: string;
};

export type Experiment = {
  schemaVersion: 1;
  experimentId: string;
  hypothesis: string;
  startTime: string;
  eligibleWallets: string[];
  controls: string[];
  decisionRules: Record<string, unknown>;
  entryRules: Record<string, unknown>;
  exitRules: Record<string, unknown>;
  tradeSizeSol: number;
  metrics: string[];
  stopCondition: Record<string, unknown>;
  manifestHash: string;
};

const b58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sig58 = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function manifestHash(value: unknown): string { return sha256(stableJson(value)); }

function roleFor(wallet: string | null, follower: string, live: Set<string>, research: Set<string>, controls: Set<string>): Role {
  if (!wallet) return "TRACKED_UNKNOWN";
  if (wallet === follower) return "FOLLOWER";
  if (live.has(wallet)) return "LIVE_SOURCE";
  if (research.has(wallet)) return "RESEARCH";
  if (controls.has(wallet)) return "CONTROL";
  return "TRACKED_UNKNOWN";
}

function findStrings(v: unknown, keys: RegExp, out: string[] = []): string[] {
  if (!v) return out;
  if (Array.isArray(v)) { for (const x of v) findStrings(x, keys, out); return out; }
  if (typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "string" && keys.test(k)) out.push(x);
    else if (typeof x === "object") findStrings(x, keys, out);
  }
  return out;
}

function findNumbers(v: unknown, keys: RegExp, out: number[] = []): number[] {
  if (!v) return out;
  if (Array.isArray(v)) { for (const x of v) findNumbers(x, keys, out); return out; }
  if (typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "number" && keys.test(k)) out.push(x);
    else if (typeof x === "object") findNumbers(x, keys, out);
  }
  return out;
}

export function normalizeAlchemyPayload(args: {
  payload: any; raw: Buffer; receivedAt: string; sourceEventId: string; verified: boolean;
  follower: string; live: Set<string>; research: Set<string>; controls: Set<string>;
}): EventEnvelope[] {
  const { payload, raw, receivedAt, sourceEventId, verified, follower, live, research, controls } = args;
  const root = payload?.event ?? payload;
  const activities: any[] = Array.isArray(root?.activity) ? root.activity : [root];
  const payloadHash = sha256(raw);
  const globalSigs = findStrings(root, /^(signature|txSignature|transactionSignature)$/i).filter(x => sig58.test(x));
  const globalSlots = findNumbers(root, /^(slot)$/i);
  const globalTimes = findNumbers(root, /^(blockTime|block_time)$/i);
  const envelopes: EventEnvelope[] = [];
  activities.forEach((activity, i) => {
    const addresses = [...new Set(findStrings(activity, /^(fromAddress|toAddress|address|account|owner|wallet)$/i).filter(x => b58.test(x)))];
    const sigs = findStrings(activity, /^(signature|txSignature|transactionSignature|hash)$/i).filter(x => sig58.test(x));
    const signature = sigs[0] ?? globalSigs[0] ?? null;
    const slot = findNumbers(activity, /^(slot)$/i)[0] ?? globalSlots[0] ?? null;
    const blockTime = findNumbers(activity, /^(blockTime|block_time)$/i)[0] ?? globalTimes[0] ?? null;
    const wallets = addresses.length ? addresses : [null];
    wallets.forEach((wallet, j) => envelopes.push({
      schemaVersion: 2,
      eventId: sha256(`${sourceEventId}:${i}:${j}:${wallet ?? "unknown"}:${signature ?? "nosig"}`),
      provider: "ALCHEMY", transport: "alchemy_webhook", receivedAt,
      providerCreatedAt: payload?.createdAt ?? null, wallet, role: roleFor(wallet, follower, live, research, controls),
      signature, slot, blockTime,
      eventType: String(activity?.category ?? activity?.type ?? root?.type ?? "ADDRESS_ACTIVITY"),
      rawPayloadHash: payloadHash, sourceEventId, prospectiveEligible: verified
    }));
  });
  return envelopes;
}

export class ProspectiveLab {
  readonly root: string;
  constructor(root: string) { this.root = root; fs.mkdirSync(root, { recursive: true }); }
  private append(name: string, value: unknown) { fs.appendFileSync(path.join(this.root, name), stableJson(value) + "\n"); }
  commitEnvelope(e: EventEnvelope) { this.append("event-envelopes.jsonl", e); }
  commitFlight(value: unknown) { this.append("flight-recorder.jsonl", value); }
  commitExecutionDecay(value: unknown) { this.append("execution-decay.jsonl", value); }
  freezeCandidate(input: Omit<CandidateEpoch, "schemaVersion" | "candidateEpochId">): CandidateEpoch {
    const epoch: CandidateEpoch = { schemaVersion: 1, candidateEpochId: sha256(stableJson(input)), ...input };
    this.append("candidate-epochs.jsonl", epoch); return epoch;
  }
  registerExperiment(input: Omit<Experiment, "schemaVersion" | "experimentId">): Experiment {
    const exp: Experiment = { schemaVersion: 1, experimentId: sha256(stableJson(input)), ...input };
    this.append("experiments.jsonl", exp); return exp;
  }
}
