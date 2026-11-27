import "server-only";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EVENT_PROPOSAL_JSON_SCHEMA,
  RIGHT_KEYS,
  RIGHT_LABELS,
  effectivePermissions,
  compactToProposal,
  type ActiveEvent,
  type EventProposal,
  type Issue,
  type RightKey,
} from "@/contracts/competitionEvent";
import { structuredCall, type AiCallRecord } from "./claude";
import { ComPdfNotConfigured, extractFields, flattenResult, parseDocument, type ComPdfRecord } from "./compdf";
import { competitionConfig } from "./config";
import { saveActiveEvent } from "./event";
import { writeJsonAtomic } from "./fsAtomic";

export interface OrganizerDoc {
  id: string;
  created_at: string;
  file_name: string;
  bytes: number;
  status: "processing" | "ready" | "failed" | "imported";
  compdf: ComPdfRecord[];
  extracted_excerpt: string | null;
  extracted_chars: number;
  ai_calls: AiCallRecord[];
  proposal: EventProposal | null;
  server_checks: string[];
  error: { code: string; message: string } | null;
  imported_event: ActiveEvent | null;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const root = () => path.join(competitionConfig().dataDir, "organizer");
const dir = (id: string) => {
  if (!ID_RE.test(id)) throw new Error("bad id");
  return path.join(root(), id);
};

export async function saveDoc(doc: OrganizerDoc): Promise<void> {
  await writeJsonAtomic(path.join(dir(doc.id), "doc.json"), doc);
}
export async function loadDoc(id: string): Promise<OrganizerDoc | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(dir(id), "doc.json"), "utf8")) as OrganizerDoc;
  } catch {
    return null;
  }
}

async function evidence(line: Record<string, unknown>) {
  const d = path.join(competitionConfig().dataDir, "evidence");
  await mkdir(d, { recursive: true });
  await appendFile(path.join(d, "organizer-calls.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
}

export async function createDoc(fileName: string, bytes: Buffer): Promise<OrganizerDoc> {
  const id = randomUUID();
  await mkdir(dir(id), { recursive: true });
  await writeFile(path.join(dir(id), "source.pdf"), bytes);
  const doc: OrganizerDoc = {
    id,
    created_at: new Date().toISOString(),
    file_name: fileName.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120),
    bytes: bytes.length,
    status: "processing",
    compdf: [],
    extracted_excerpt: null,
    extracted_chars: 0,
    ai_calls: [],
    proposal: null,
    server_checks: [],
    error: null,
    imported_event: null,
  };
  await saveDoc(doc);
  return doc;
}

const SYSTEM = [
  "你是 MEmory 的主辦方文件代理。MEmory 讓活動參加者用自己拍的照片與影片生成個人記憶短片。",
  "你會收到 ComPDF 從主辦方 PDF（活動提案、內容授權書、合作協議）解析出的文字，以及關鍵欄位抽取結果。",
  "任務：整理出活動設定與內容授權政策提案，交給人工確認。規則：",
  "1. 每個欄位只能根據文件內容；找不到就 value=null，並在 issues 加一筆 kind=missing。",
  "2. sources 放支持該欄位的原文短引文（逐字，最多 80 字）與頁碼（看得出頁碼才填，否則 null）。",
  "3. 授權（rights）只有文件明確允許時才可標 allowed；明確禁止或附條件（例如須另行書面同意）標 restricted；沒提到標 unknown；文件內前後矛盾標 conflict，並在 issues 加一筆 kind=conflict，引用兩邊原文。",
  "4. 用語模糊（例如「原則上」「視情況」「另議」）時在 issues 加 kind=ambiguous。",
  "5. 協議尚未簽署、簽名欄空白、標示草稿時 agreement_status 用 unsigned 或 draft，並加 kind=approval_pending。",
  "6. 日期一律輸出 YYYY-MM-DD；時程（schedule）照文件列出。",
  "7. 你的判讀不是法律意見，也不是最終授權；不要替主辦方做決定。所有文字用繁體中文。",
  `權利項目定義：${RIGHT_KEYS.map((k) => `${k}=${RIGHT_LABELS[k]}`).join("；")}`,
].join("\n");

const EXTRACT_KEYS = ["活動名稱", "活動日期", "地點", "主辦單位", "生成有效期間", "分享", "下載", "商業使用", "簽署"];

/** Deterministic server rules applied after the model — they can only make things stricter. */
export function enforceProposalRules(p: EventProposal): { proposal: EventProposal; checks: string[] } {
  const out = structuredClone(p);
  const checks: string[] = [];
  const addIssue = (i: Issue) => {
    if (!out.issues.some((x) => x.kind === i.kind && x.field === i.field)) out.issues.push(i);
  };
  for (const k of RIGHT_KEYS) {
    const r = out.rights[k];
    if (r.status === "allowed" && r.sources.length === 0) {
      r.status = "unknown";
      checks.push(`right_without_source_downgraded:${k}`);
      addIssue({ kind: "ambiguous", field: k, detail: "AI 標示為允許，但沒有提供原文依據，系統改為未知。", sources: [] });
    }
  }
  for (const f of ["event_name", "start_date", "venue"] as const) {
    if (!out[f].value) {
      checks.push(`missing:${f}`);
      addIssue({ kind: "missing", field: f, detail: "文件中找不到此欄位。", sources: [] });
    }
  }
  for (const f of ["start_date", "end_date", "generation_valid_from", "generation_valid_until"] as const) {
    const v = out[f].value;
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      out[f].value = null;
      checks.push(`bad_date_cleared:${f}`);
      addIssue({ kind: "ambiguous", field: f, detail: "日期格式無法確認，已清除，請人工填寫。", sources: [] });
    }
  }
  if (out.agreement_status !== "signed") {
    checks.push(`agreement_${out.agreement_status}`);
    addIssue({ kind: "approval_pending", field: "agreement_status", detail: "協議尚未確認簽署；啟用活動前需要人工確認。", sources: [] });
  }
  return { proposal: out, checks };
}

/** AI interpretation of ComPDF output + deterministic server rules. */
export async function interpretDocument(fileName: string, body: string, kv: string): Promise<{ proposal: EventProposal | null; checks: string[]; calls: AiCallRecord[] }> {
  const cfg = competitionConfig();
  const calls: AiCallRecord[] = [];
  for (const model of [cfg.storyModel, cfg.fallbackModel]) {
    const { data, record } = await structuredCall({
      step: "document_interpretation",
      model,
      system: SYSTEM,
      content: [{ type: "text", text: `檔名：${fileName}\n\n=== ComPDF documentParsing ===\n${body}\n\n=== ComPDF documentExtract（關鍵欄位）===\n${kv || "（無）"}` }],
      schema: EVENT_PROPOSAL_JSON_SCHEMA as unknown as Record<string, unknown>,
      effort: "medium",
    });
    calls.push(record);
    const v = data ? compactToProposal(data) : null;
    if (v) {
      const enforced = enforceProposalRules(v);
      return { proposal: enforced.proposal, checks: enforced.checks, calls };
    }
    if (data) record.outcome = "invalid_json";
  }
  return { proposal: null, checks: [], calls };
}

export async function processDoc(id: string): Promise<void> {
  const doc = await loadDoc(id);
  if (!doc) return;
  const file = path.join(dir(id), "source.pdf");
  const fail = async (code: string, message: string) => {
    doc.status = "failed";
    doc.error = { code, message };
    await saveDoc(doc);
  };
  try {
    const parsed = await parseDocument(file);
    doc.compdf.push(parsed.record);
    await evidence({ doc: id, kind: "compdf", ...parsed.record });
    // documentExtract returned api_code 03000 ("参数校验异常") on every live attempt (2026-11-27, see
    // competition/BLOCKERS.md B-7); it is optional and only runs when COMPDF_ENABLE_EXTRACT=1.
    const extracted = process.env.COMPDF_ENABLE_EXTRACT === "1"
      ? await extractFields(file, EXTRACT_KEYS)
      : { text: null, json: null, record: null };
    if (extracted.record) {
      doc.compdf.push(extracted.record);
      await evidence({ doc: id, kind: "compdf", ...extracted.record });
    }
    await saveDoc(doc);
    if (!parsed.text) return fail("COMPDF_FAILED", "ComPDF 文件解析失敗，請檢查 API 金鑰或檔案。");
    const body = flattenResult(parsed.text, parsed.json);
    const kv = flattenResult(extracted.text, extracted.json, 8000);
    doc.extracted_chars = body.length;
    doc.extracted_excerpt = body.slice(0, 1500);
    await writeFile(path.join(dir(id), "compdf-parsing.txt"), body);
    await writeFile(path.join(dir(id), "compdf-extract.txt"), kv);

    const r = await interpretDocument(doc.file_name, body, kv);
    doc.ai_calls.push(...r.calls);
    for (const c of r.calls) await evidence({ doc: id, kind: "ai", ...c });
    if (!r.proposal) return fail("AI_INTERPRETATION_FAILED", "AI 無法整理這份文件，請人工設定。");
    doc.proposal = r.proposal;
    doc.server_checks = r.checks;
    doc.status = "ready";
    await saveDoc(doc);
  } catch (err) {
    if (err instanceof ComPdfNotConfigured) return fail("COMPDF_NOT_CONFIGURED", "ComPDF API 金鑰尚未設定。");
    console.error("[organizer] failed", err instanceof Error ? err.message.slice(0, 200) : "unknown");
    return fail("INTERNAL", "處理文件時發生錯誤。");
  }
}

export interface ConfirmInput {
  rights: Partial<Record<RightKey, boolean>>;
  overrides: Partial<Record<"event_name" | "start_date" | "end_date" | "venue" | "description" | "generation_valid_from" | "generation_valid_until", string>>;
  acknowledge_unsigned: boolean;
  reviewer_note: string;
}

/**
 * Human confirmation → active event. Restricted/unknown/conflict rights cannot be enabled by
 * the request. An unsigned agreement leaves the event "pending_signature" unless the reviewer
 * explicitly acknowledges activating it as a test.
 */
export async function confirmDoc(id: string, input: ConfirmInput): Promise<ActiveEvent> {
  const doc = await loadDoc(id);
  if (!doc?.proposal) throw new Error("NOT_READY");
  const p = doc.proposal;
  const o = input.overrides;
  const pick = (k: keyof ConfirmInput["overrides"], v: string | null) => {
    const s = o[k]?.trim();
    return s ? s.slice(0, 200) : v;
  };
  const name = pick("event_name", p.event_name.value);
  if (!name) throw new Error("NAME_REQUIRED");
  const signed = p.agreement_status === "signed";
  const ev: ActiveEvent = {
    id: `doc-${id.slice(0, 8)}`,
    name,
    start_date: pick("start_date", p.start_date.value),
    end_date: pick("end_date", p.end_date.value),
    venue: pick("venue", p.venue.value),
    organizer: p.organizer.value,
    description: pick("description", p.description.value),
    schedule: p.schedule.map((s) => ({ time: s.time, item: s.item })),
    generation_valid_from: pick("generation_valid_from", p.generation_valid_from.value),
    generation_valid_until: pick("generation_valid_until", p.generation_valid_until.value),
    permissions: effectivePermissions(p, input.rights),
    source: "document",
    source_document: doc.file_name,
    confirmed_at: new Date().toISOString(),
    confirmed_by_note: input.reviewer_note.slice(0, 300) || null,
    activation: signed || input.acknowledge_unsigned ? "active" : "pending_signature",
  };
  for (const k of ["start_date", "end_date", "generation_valid_from", "generation_valid_until"] as const) {
    if (ev[k] && !/^\d{4}-\d{2}-\d{2}$/.test(ev[k]!)) throw new Error(`BAD_DATE_${k.toUpperCase()}`);
  }
  await saveActiveEvent(ev);
  doc.status = "imported";
  doc.imported_event = ev;
  await saveDoc(doc);
  await evidence({ doc: id, kind: "import", activation: ev.activation, permissions: ev.permissions });
  return ev;
}
