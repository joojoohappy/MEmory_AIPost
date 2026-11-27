"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RIGHT_KEYS, RIGHT_LABELS, type EventProposal, type RightKey, type ActiveEvent } from "@/contracts/competitionEvent";

/**
 * /organizer — minimal MEmory Organizer Document Agent (competition Track C).
 * PDF → ComPDF (documentParsing + documentExtract) → AI interpretation → issues → human
 * confirmation → event config imported into /studio. Unknown rights stay disabled.
 */

interface Doc {
  id: string;
  file_name: string;
  status: "processing" | "ready" | "failed" | "imported";
  compdf: { operation: string; outcome: string; task_id: string | null; latency_ms: number; http_status: number | null; api_code: string | null; result_bytes: number | null; error?: string }[];
  extracted_excerpt: string | null;
  extracted_chars: number;
  ai_calls: { step: string; model: string; outcome: string; latency_ms: number; request_id: string | null }[];
  proposal: EventProposal | null;
  server_checks: string[];
  error: { code: string; message: string } | null;
  imported_event: ActiveEvent | null;
}

const STATUS_LABEL: Record<string, { t: string; tone: string }> = {
  allowed: { t: "文件明確允許", tone: "ok" },
  restricted: { t: "受限／附條件", tone: "warn" },
  unknown: { t: "文件未提及", tone: "bad" },
  conflict: { t: "文件內容矛盾", tone: "bad" },
};
const ISSUE_LABEL: Record<string, string> = { missing: "缺漏", ambiguous: "模糊", conflict: "矛盾", approval_pending: "待簽署／核准" };
const FIELDS = [
  ["event_name", "活動名稱"],
  ["start_date", "開始日期"],
  ["end_date", "結束日期"],
  ["venue", "地點"],
  ["organizer", "主辦單位"],
  ["description", "活動說明"],
  ["generation_valid_from", "生成開放日"],
  ["generation_valid_until", "生成截止日"],
] as const;

export default function OrganizerPage() {
  const [token, setToken] = useState(() => (typeof window === "undefined" ? "" : sessionStorage.getItem("organizer-token") ?? ""));
  const [file, setFile] = useState<File | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rights, setRights] = useState<Partial<Record<RightKey, boolean>>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState("");
  const [imported, setImported] = useState<ActiveEvent | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const headers = useCallback((): Record<string, string> => (token ? { "x-organizer-token": token } : {}), [token]);

  const poll = useCallback(
    (id: string) => {
      const tick = async () => {
        const r = await fetch(`/api/organizer/documents/${id}`, { headers: headers(), cache: "no-store" });
        if (!r.ok) return setError(`讀取失敗（${r.status}）`);
        const d = (await r.json()).doc as Doc;
        setDoc(d);
        if (d.status === "processing") timer.current = setTimeout(tick, 2000);
      };
      void tick();
    },
    [headers],
  );
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function upload() {
    if (!file) return;
    setError(null);
    setDoc(null);
    setImported(null);
    sessionStorage.setItem("organizer-token", token);
    const fd = new FormData();
    fd.set("file", file);
    const r = await fetch("/api/organizer/documents", { method: "POST", body: fd, headers: headers() });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return setError(body?.error?.code === "FORBIDDEN" ? "需要主辦方存取碼。" : `上傳失敗（${body?.error?.code ?? r.status}）`);
    setRights({});
    setOverrides({});
    setAck(false);
    poll(body.doc.id);
  }

  async function confirm() {
    if (!doc) return;
    const r = await fetch(`/api/organizer/documents/${doc.id}/confirm`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ rights, overrides, acknowledge_unsigned: ack, reviewer_note: note }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return setError(`匯入失敗（${body?.error?.code ?? r.status}）`);
    setImported(body.event);
  }

  async function reset() {
    await fetch("/api/organizer/reset", { method: "POST", headers: headers() });
    setImported(null);
    setError("已恢復為內建示範設定。");
  }

  const p = doc?.proposal;
  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <header className="topbar">
        <a className="brand" href="/organizer">
          MEmory
          <small>主辦方文件代理・競賽版</small>
        </a>
        <a className="small muted" href="/studio">← 記憶工作室</a>
      </header>
      <p className="muted">上傳活動提案、內容授權書或合作協議（PDF）。ComPDF 解析文件，AI 整理活動設定與授權政策提案，並標出缺漏、模糊與矛盾之處。所有授權由你確認後才會生效；未知的權利一律維持關閉。</p>

      <section className="card stack">
        <div className="field">
          <label className="small">主辦方存取碼（部署環境需要）</label>
          <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </div>
        <input className="input" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" disabled={!file || doc?.status === "processing"} onClick={upload}>
            {doc?.status === "processing" ? "處理中…" : "上傳並分析"}
          </button>
          <button className="btn btn-ghost" onClick={reset}>恢復內建示範設定</button>
        </div>
        {error && <p className="notice" data-tone="warn" role="alert">{error}</p>}
      </section>

      {doc && (
        <section className="stack" style={{ marginTop: "var(--sp-5)" }} aria-live="polite">
          <div className="card-quiet card stack">
            <h2 className="h3" style={{ margin: 0 }}>執行紀錄・{doc.file_name}</h2>
            <ul className="small mono" style={{ margin: 0 }}>
              {doc.compdf.map((c, i) => (
                <li key={i}>ComPDF {c.operation}・{c.outcome}・HTTP {c.http_status ?? "-"}・code {c.api_code ?? "-"}・task {c.task_id ?? "-"}・{(c.latency_ms / 1000).toFixed(1)}s{c.result_bytes ? `・${c.result_bytes} B` : ""}{c.error ? `・${c.error}` : ""}</li>
              ))}
              {doc.ai_calls.map((c, i) => (
                <li key={`a${i}`}>AI {c.step}・{c.model}・{c.outcome}・{(c.latency_ms / 1000).toFixed(1)}s{c.request_id ? `・${c.request_id}` : ""}</li>
              ))}
              {doc.status === "processing" && <li>處理中…</li>}
            </ul>
            {doc.extracted_excerpt && (
              <details>
                <summary className="small">ComPDF 解析內容（前 1500 字，共 {doc.extracted_chars} 字）</summary>
                <pre className="small" style={{ whiteSpace: "pre-wrap" }}>{doc.extracted_excerpt}</pre>
              </details>
            )}
            {doc.error && <p className="notice" data-tone="bad">{doc.error.message}</p>}
          </div>

          {p && (
            <>
              {p.issues.length > 0 && (
                <div className="card stack">
                  <h2 className="h3" style={{ margin: 0 }}>需要你確認的問題（{p.issues.length}）</h2>
                  <ul className="small" style={{ margin: 0 }}>
                    {p.issues.map((x, i) => (
                      <li key={i} style={{ marginBottom: 6 }}>
                        <span className="chip" data-tone={x.kind === "approval_pending" ? "warn" : "bad"}>{ISSUE_LABEL[x.kind]}</span> <b>{x.field}</b>：{x.detail}
                        {x.sources.map((s, j) => <div key={j} className="faint">「{s.quote}」{s.page ? `（第 ${s.page} 頁）` : ""}</div>)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="card stack">
                <h2 className="h3" style={{ margin: 0 }}>活動設定提案（可修改）</h2>
                {FIELDS.map(([k, label]) => (
                  <div className="field" key={k}>
                    <label className="small">{label}</label>
                    <input className="input" value={overrides[k] ?? p[k].value ?? ""} placeholder="（文件未提供）" onChange={(e) => setOverrides({ ...overrides, [k]: e.target.value })} />
                    {p[k].sources.slice(0, 2).map((s, j) => <p key={j} className="small faint" style={{ margin: 0 }}>出處：「{s.quote}」{s.page ? `（第 ${s.page} 頁）` : ""}</p>)}
                  </div>
                ))}
                {p.schedule.length > 0 && (
                  <ul className="small" style={{ margin: 0 }}>{p.schedule.map((s, i) => <li key={i}><span className="mono">{s.time}</span> {s.item}</li>)}</ul>
                )}
                <p className="small">協議狀態：<b>{p.agreement_status}</b></p>
              </div>

              <div className="card stack">
                <h2 className="h3" style={{ margin: 0 }}>內容授權政策提案</h2>
                <p className="small faint">只有「文件明確允許」的項目可以勾選啟用；其他項目維持關閉。AI 的判讀不是法律意見。</p>
                {RIGHT_KEYS.map((k) => {
                  const r = p.rights[k];
                  const s = STATUS_LABEL[r.status]!;
                  return (
                    <label key={k} className="check" style={{ alignItems: "flex-start" }}>
                      <input type="checkbox" disabled={r.status !== "allowed"} checked={r.status === "allowed" && rights[k] === true} onChange={(e) => setRights({ ...rights, [k]: e.target.checked })} />
                      <span className="small">
                        {RIGHT_LABELS[k]} <span className="chip" data-tone={s.tone}>{s.t}</span>
                        <br />
                        <span className="faint">{r.note}</span>
                        {r.sources.slice(0, 2).map((q, j) => <span key={j} className="faint"><br />「{q.quote}」{q.page ? `（第 ${q.page} 頁）` : ""}</span>)}
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="card stack">
                {p.agreement_status !== "signed" && (
                  <label className="check">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    <span className="small">協議尚未簽署。我確認以「測試」身分先啟用此活動（不勾選則匯入後維持「待簽署」，記憶工作室不會開放）。</span>
                  </label>
                )}
                <input className="input" placeholder="確認備註（選填）" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn btn-primary" disabled={doc.status === "processing"} onClick={confirm}>確認並匯入到記憶工作室</button>
                {imported && (
                  <p className="notice" data-tone="ok">
                    已匯入「{imported.name}」・狀態 {imported.activation === "active" ? "已啟用" : "待簽署"}・開放項目：
                    {RIGHT_KEYS.filter((k) => imported.permissions[k]).map((k) => RIGHT_LABELS[k]).join("、") || "無"}。<a href="/studio">前往記憶工作室 →</a>
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
