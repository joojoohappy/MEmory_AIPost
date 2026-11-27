import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { competitionConfig } from "./config";
import { unzip } from "./unzip";

/**
 * ComPDF cloud API (KDAN) — real integration, x-api-key auth.
 * Docs: https://www.compdf.com/guides/api-reference/v2/documentParsing
 *       https://www.compdf.com/guides/api-reference/v1/documentExtract
 * The API key stays on the server. The execution record keeps only task ids, status, timings
 * and sizes — never the key or the document content.
 */

export interface ComPdfRecord {
  operation: "documentParsing" | "documentExtract";
  endpoint: string;
  started_at: string;
  latency_ms: number;
  http_status: number | null;
  api_code: string | null;
  task_id: string | null;
  file_status: string | null;
  result_bytes: number | null;
  result_type: string | null;
  outcome: "ok" | "error";
  error?: string;
}

export class ComPdfNotConfigured extends Error {}

interface FileInfo {
  taskId?: string;
  downloadUrl?: string;
  status?: string;
  failureCode?: string;
  failureReason?: string;
}

function firstFileInfo(data: unknown): FileInfo | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.downloadUrl === "string") return d as FileInfo;
  const list = (d.fileInfoDTOList ?? d.fileInfoList) as FileInfo[] | undefined;
  if (Array.isArray(list) && list[0]) return { taskId: d.taskId as string | undefined, ...list[0] };
  return null;
}

async function call(
  operation: ComPdfRecord["operation"],
  file: string,
  extra: Record<string, string>,
): Promise<{ text: string | null; json: unknown; record: ComPdfRecord }> {
  const cfg = competitionConfig();
  if (!cfg.compdfKey) throw new ComPdfNotConfigured("COMPDF_API_KEY is not configured");
  const endpoint = `${cfg.compdfBaseUrl}/v2/process/idp/${operation}`;
  const started = Date.now();
  const record: ComPdfRecord = {
    operation,
    endpoint,
    started_at: new Date(started).toISOString(),
    latency_ms: 0,
    http_status: null,
    api_code: null,
    task_id: null,
    file_status: null,
    result_bytes: null,
    result_type: null,
    outcome: "error",
  };
  try {
    const fd = new FormData();
    const buf = await readFile(file);
    fd.set("file", new Blob([new Uint8Array(buf)], { type: "application/pdf" }), path.basename(file));
    fd.set("language", "2");
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    const res = await fetch(endpoint, { method: "POST", headers: { "x-api-key": cfg.compdfKey, Accept: "*/*" }, body: fd, signal: AbortSignal.timeout(180_000) });
    record.http_status = res.status;
    const body = (await res.json().catch(() => null)) as { code?: string | number; msg?: string; message?: string; data?: unknown } | null;
    record.api_code = body?.code !== undefined ? String(body.code) : null;
    const info = firstFileInfo(body?.data);
    record.task_id = info?.taskId ?? ((body?.data as Record<string, unknown> | undefined)?.taskId as string | undefined) ?? null;
    record.file_status = info?.status ?? null;
    if (!res.ok || record.api_code !== "200" || !info?.downloadUrl) {
      record.error = `api:${record.api_code ?? res.status}:${(info?.failureCode ?? body?.msg ?? body?.message ?? "").toString().slice(0, 120)}`;
      record.latency_ms = Date.now() - started;
      return { text: null, json: null, record };
    }
    const dl = await fetch(info.downloadUrl, { signal: AbortSignal.timeout(60_000) });
    const ct = dl.headers.get("content-type") ?? "";
    const raw = Buffer.from(await dl.arrayBuffer());
    record.result_bytes = raw.length;
    record.result_type = ct.split(";")[0] || null;
    record.latency_ms = Date.now() - started;
    let text: string;
    if (raw.subarray(0, 2).toString("latin1") === "PK") {
      // ComPDF delivers IDP results as a ZIP (observed live 2026-11-27): prefer JSON, then Markdown/text.
      const files = unzip(raw);
      record.result_type = `zip:${files.map((f) => f.name.split(".").pop()).join(",")}`.slice(0, 120);
      const pickExt = (re: RegExp) => files.filter((f) => re.test(f.name));
      const chosen = [...pickExt(/\.json$/i), ...pickExt(/\.(md|markdown|txt)$/i)];
      if (!chosen.length) {
        record.error = "zip_without_text";
        return { text: null, json: null, record };
      }
      text = chosen[0]!.data.toString("utf8");
    } else {
      text = raw.toString("utf8");
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* markdown / text result */
    }
    record.outcome = "ok";
    return { text, json, record };
  } catch (err) {
    record.latency_ms = Date.now() - started;
    record.error = err instanceof Error ? `${err.name}:${err.message.slice(0, 120)}` : "unknown";
    return { text: null, json: null, record };
  }
}

/** Full-document parsing (layout-aware text, headings, tables) with page structure. */
export function parseDocument(file: string) {
  return call("documentParsing", file, { enableOcr: "1", ocrRecognitionLang: "AUTO" });
}

/** Key-value extraction for the fields MEmory needs (used as a cross-check). */
export function extractFields(file: string, keys: string[]) {
  // Shape follows the documented example: {"keys":[...],"tableHandles":[...],"extractType":2} plus an empty password.
  return call("documentExtract", file, { password: "", parameter: JSON.stringify({ keys, tableHandles: ["時間"], extractType: 2 }) });
}

/**
 * Flatten whatever JSON the API returned into page-tagged plain text for the model.
 * Keeps "[第 N 頁]" markers when the structure carries page numbers.
 */
export function flattenResult(text: string | null, json: unknown, maxChars = 60_000): string {
  if (!json) return (text ?? "").slice(0, maxChars);
  // documentParsing shape (observed live): { result: { pages: [{ page_id, structured: [{ type, text }] }] } }
  const pages = (json as { result?: { pages?: { page_id?: number; structured?: { type?: string; text?: string }[] }[] } }).result?.pages;
  if (Array.isArray(pages)) {
    const lines: string[] = [];
    for (const pg of pages) {
      for (const b of pg.structured ?? []) {
        const t = (b.text ?? "")
          .replace(/<\/tr>/gi, "\n")
          .replace(/<\/t[dh]>/gi, " | ")
          .replace(/<[^>]+>/g, "")
          .split("\n").map((x) => x.trim().replace(/\s*\|\s*$/, "")).filter(Boolean).join("；")
          .trim();
        if (!t || b.type === "header" || b.type === "footer") continue;
        lines.push(`[第 ${pg.page_id ?? "?"} 頁] ${t}`);
      }
    }
    return lines.join("\n").slice(0, maxChars);
  }
  const out: string[] = [];
  const walk = (v: unknown, page: string | null) => {
    if (out.join("\n").length > maxChars) return;
    if (typeof v === "string") {
      const s = v.trim();
      if (s && !/^https?:\/\//.test(s)) out.push(page ? `[${page}] ${s}` : s);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, page));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const pm = /^page[-_ ]?(\d+)$/i.exec(k);
        const p = pm ? `第 ${pm[1]} 頁` : page;
        if (["downloadUrl", "fileUrl", "imageUrl", "url", "bbox", "box", "position"].includes(k)) continue;
        if (typeof x === "number" && /page/i.test(k)) {
          page = `第 ${x} 頁`;
          continue;
        }
        if (typeof x === "string" && !["text", "content", "markdown", "value", "title"].includes(k) && x.length < 40 && !pm) {
          out.push(`${p ? `[${p}] ` : ""}${k}: ${x}`);
        } else walk(x, p);
      }
    }
  };
  walk(json, null);
  return out.join("\n").slice(0, maxChars);
}
