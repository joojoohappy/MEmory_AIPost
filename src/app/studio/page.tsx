"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STUDIO_LIMITS, TONES, TONE_LABELS, type Tone } from "@/contracts/competition";
import { RIGHT_KEYS, RIGHT_LABELS, type ActiveEvent, type StudioGate } from "@/contracts/competitionEvent";
import { countGraphemes } from "@/contracts/reflection";

/**
 * /studio — competition build of the MEmory consumer flow (competition/SCOPE.md, Track A).
 * event → media → reflection + tone → real AI analysis → storyboard → FFmpeg film → preview/download.
 */

interface EventInfo {
  event: ActiveEvent;
  gate: StudioGate;
  ai: { configured: boolean; vision_model: string; story_model: string };
  renderer: { name: string; font: boolean };
  access?: { code_required: boolean };
  public_repo_url?: string | null;
}

interface Job {
  id: string;
  status: "queued" | "analyzing" | "planning" | "rendering" | "done" | "failed";
  sample_set: string | null;
  reflection: string;
  tone: Tone;
  media: { index: number; type: "photo" | "video"; duration_seconds: number | null }[];
  analysis: { index: number; scene: string; visible_elements: string[]; lighting: string; energy: string; people_visible: boolean }[] | null;
  storyboard: {
    title: string;
    narrative: string;
    shots: { media_index: number; seconds: number; start_seconds: number; caption: string | null; grounding: string }[];
    reflection_after_shot: number;
    ending_text: string;
  } | null;
  plan_source: "claude" | "template" | null;
  plan_repairs: string[];
  ai_calls: { step: string; model: string; request_id: string | null; latency_ms: number; input_tokens: number; output_tokens: number; outcome: string }[];
  render: { seconds: number | null; bytes: number | null; renderer: string } | null;
  error: { code: string; message: string } | null;
  download_allowed: boolean;
}

const SAMPLES: { id: string; label: string; files: string[]; reflection: string; tone: Tone }[] = [
  {
    id: "night-concert",
    label: "範例 A・夜間演出（合成插畫）",
    files: ["01-stage-lights.jpg", "02-golden-spot.jpg", "03-encore.jpg"],
    reflection: "燈全亮起來的那一刻，我跟著大家一起大喊。",
    tone: "bright",
  },
  {
    id: "day-fair",
    label: "範例 B・白天市集（合成插畫）",
    files: ["01-market-tents.jpg", "02-afternoon.jpg", "03-sunset-lanterns.jpg"],
    reflection: "慢慢走完一圈，傍晚的燈籠讓我想多待一下。",
    tone: "quiet",
  },
];

const ERRORS: Record<string, string> = {
  CONSENT_REQUIRED: "請先勾選同意，才能開始產生。",
  TOO_FEW_FILES: `至少需要 ${STUDIO_LIMITS.MIN_FILES} 個素材。`,
  TOO_MANY_FILES: `最多 ${STUDIO_LIMITS.MAX_FILES} 個素材。`,
  FILE_TOO_LARGE: "有檔案超過 60 MB。",
  PAYLOAD_TOO_LARGE: "素材總大小超過上限。",
  MEDIA_UNSUPPORTED: "有檔案格式不支援（支援 JPG／PNG／WebP 照片與 MP4／MOV／WebM 影片；HEIC 請先轉檔）。",
  VIDEO_TOO_LONG: "影片請在 90 秒以內。",
  REFLECTION_TOO_LONG: `感受文字最多 ${STUDIO_LIMITS.REFLECTION_MAX_GRAPHEMES} 字。`,
  REFLECTION_UNSAFE: "感受文字不能包含 < 或 >。",
  TONE_INVALID: "請選擇一種氛圍。",
  PHOTOS_NOT_PERMITTED: "此活動的授權設定不允許使用照片。",
  VIDEOS_NOT_PERMITTED: "此活動的授權設定不允許使用影片。",
  STUDIO_CLOSED_INACTIVE: "此活動尚未啟用（等待主辦方確認或簽署）。",
  STUDIO_CLOSED_BEFORE_WINDOW: "還沒到可以生成記憶短片的期間。",
  STUDIO_CLOSED_AFTER_WINDOW: "已超過可以生成記憶短片的期間。",
  STUDIO_CLOSED_NO_MEDIA_ALLOWED: "此活動目前沒有開放任何素材類型。",
  INTERNAL: "伺服器發生錯誤，請稍後再試。",
  RATE_LIMITED: "你這一小時已產生多支短片，請稍後再試。",
  DAILY_CAP_REACHED: "今天的示範額度已用完，請明天再試。",
  ACCESS_CODE_REQUIRED: "通行碼不正確。即時產生需要評審通行碼；沒有通行碼可以先看下方的範例短片。",
  ACCESS_CODE_LOCKED: "通行碼錯誤次數過多，請一小時後再試。",
};

const STEPS: { key: Job["status"]; label: string }[] = [
  { key: "analyzing", label: "AI 理解你的素材" },
  { key: "planning", label: "AI 撰寫敘事與分鏡" },
  { key: "rendering", label: "用你的原始素材合成影片" },
  { key: "done", label: "完成" },
];

const GROUNDING: Record<string, string> = { visual: "根據畫面", reflection: "根據你的話", event: "根據活動資訊", none: "—" };

export default function StudioPage() {
  const [info, setInfo] = useState<EventInfo | null>(null);
  const [mode, setMode] = useState<"sample" | "upload">("sample");
  const [sample, setSample] = useState(SAMPLES[0]!.id);
  const [files, setFiles] = useState<File[]>([]);
  const [reflection, setReflection] = useState(SAMPLES[0]!.reflection);
  const [tone, setTone] = useState<Tone>(SAMPLES[0]!.tone);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [accessCode, setAccessCode] = useState(() => {
    if (typeof window === "undefined") return "";
    // A judge link may carry the code (?code=...): keep it for this tab and drop it from the address bar.
    const url = new URL(window.location.href);
    const fromLink = url.searchParams.get("code")?.trim();
    if (fromLink) {
      sessionStorage.setItem("memory.studioAccess", fromLink);
      url.searchParams.delete("code");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      return fromLink;
    }
    return sessionStorage.getItem("memory.studioAccess") ?? "";
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void fetch("/api/studio/event", { cache: "no-store" }).then(async (r) => setInfo(await r.json()));
  }, []);

  const graphemes = useMemo(() => countGraphemes(reflection.trim()), [reflection]);
  const previews = useMemo(() => files.map((f) => ({ name: f.name, type: f.type, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const poll = useCallback((id: string) => {
    const tick = async () => {
      const r = await fetch(`/api/studio/jobs/${id}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()).job as Job;
      setJob(j);
      if (j.status !== "done" && j.status !== "failed") timer.current = setTimeout(tick, 1500);
    };
    void tick();
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function submit() {
    setError(null);
    setJob(null);
    const fd = new FormData();
    if (mode === "sample") fd.set("sample", sample);
    else files.forEach((f) => fd.append("files", f));
    fd.set("reflection", reflection);
    fd.set("tone", tone);
    fd.set("consent", consent ? "1" : "0");
    setBusy(true);
    try {
      sessionStorage.setItem("memory.studioAccess", accessCode.trim());
      const r = await fetch("/api/studio/jobs", { method: "POST", body: fd, headers: { "x-studio-access": accessCode.trim() } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(ERRORS[body?.error?.code] ?? `無法開始（${body?.error?.code ?? r.status}）`);
        return;
      }
      setJob(body.job);
      poll(body.job.id);
    } catch {
      setError("網路連線失敗，請再試一次。");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!job) return;
    await fetch(`/api/studio/jobs/${job.id}`, { method: "DELETE" });
    setJob(null);
  }

  const ev = info?.event;
  const gate = info?.gate;
  const running = job && job.status !== "done" && job.status !== "failed";
  const needCode = Boolean(info?.access?.code_required);
  const canSubmit = !busy && !running && consent && gate?.open && info?.ai.configured && (!needCode || accessCode.trim().length > 0) && graphemes <= STUDIO_LIMITS.REFLECTION_MAX_GRAPHEMES &&
    (mode === "sample" || (files.length >= STUDIO_LIMITS.MIN_FILES && files.length <= STUDIO_LIMITS.MAX_FILES));

  return (
    <main className="page" style={{ maxWidth: 720 }}>
      <header className="topbar">
        <a className="brand" href="/studio">
          MEmory
          <small>記憶工作室・競賽版</small>
        </a>
        <a className="small muted" href="/organizer">主辦方文件代理 →</a>
      </header>

      {!info && <p className="muted">載入活動設定中…</p>}
      {ev && (
        <section className="card stack" aria-label="活動">
          <div className="row-between">
            <h1 className="h2" style={{ margin: 0 }}>{ev.name}</h1>
            <span className="chip" data-tone={ev.source === "document" ? "info" : "warn"}>
              {ev.source === "document" ? "由主辦方文件匯入" : "內建示範設定"}
            </span>
          </div>
          {(ev.start_date || ev.venue) && (
            <p className="mono small">{[ev.start_date && (ev.end_date && ev.end_date !== ev.start_date ? `${ev.start_date} – ${ev.end_date}` : ev.start_date), ev.venue].filter(Boolean).join("・")}</p>
          )}
          {ev.description && <p className="muted">{ev.description}</p>}
          {ev.schedule.length > 0 && (
            <ul className="small muted" style={{ margin: 0 }}>
              {ev.schedule.slice(0, 6).map((s, i) => <li key={i}><span className="mono">{s.time}</span> {s.item}</li>)}
            </ul>
          )}
          <details>
            <summary className="small">內容授權設定</summary>
            <ul className="small" style={{ margin: "8px 0 0" }}>
              {RIGHT_KEYS.map((k) => (
                <li key={k}>{ev.permissions[k] ? "✓ 開放" : "✕ 未開放"}・{RIGHT_LABELS[k]}</li>
              ))}
            </ul>
            {ev.generation_valid_from && <p className="small faint">生成期間：{ev.generation_valid_from} – {ev.generation_valid_until ?? "未定"}</p>}
          </details>
          {gate && !gate.open && <p className="notice" data-tone="warn">{ERRORS[`STUDIO_CLOSED_${gate.reason.toUpperCase()}`]}</p>}
        </section>
      )}

      {info && !info.ai.configured && (
        <p className="notice" data-tone="bad">AI 服務尚未設定（缺少 API 金鑰），目前無法產生記憶短片。這個版本不會用假資料冒充 AI 結果。</p>
      )}

      {needCode && !accessCode && (
        <p className="notice" data-tone="warn" style={{ marginTop: "var(--sp-5)" }}>
          <strong>評審請注意：</strong>即時產生短片需要「評審通行碼」，通行碼寫在投稿表單的「作品交付連結／測試方式」裡（使用表單中的完整連結會自動帶入）。沒有通行碼也可以先看下方的範例短片{info?.public_repo_url ? <>和<a href={info.public_repo_url} target="_blank" rel="noreferrer">公開程式碼與執行證據</a></> : null}。
        </p>
      )}
      {needCode && (
        <section className="card card-quiet stack" style={{ marginTop: "var(--sp-5)" }}>
          <h2 className="h3">範例短片（預先產生，不是即時結果）</h2>
          <p className="small faint">這支短片是先前用「夜間演唱會」合成範例素材，經 Claude 實際分析與規劃、再以 FFmpeg 合成的結果，放在這裡供沒有通行碼的訪客參考。即時產生會呼叫付費 AI 服務，因此需要評審通行碼。</p>
          <video src="/studio/example-night-concert.mp4" controls playsInline preload="metadata" style={{ width: "100%", maxWidth: 360, borderRadius: 12 }} />
        </section>
      )}

      <section className="stack" style={{ marginTop: "var(--sp-5)" }}>
        <h2 className="h3">1・你的素材</h2>
        <div className="row" role="tablist">
          <button className={`btn ${mode === "sample" ? "btn-primary" : "btn-ghost"}`} onClick={() => setMode("sample")} role="tab" aria-selected={mode === "sample"}>用範例素材試試</button>
          <button className={`btn ${mode === "upload" ? "btn-primary" : "btn-ghost"}`} onClick={() => setMode("upload")} role="tab" aria-selected={mode === "upload"}>上傳我的照片／影片</button>
        </div>
        {mode === "sample" ? (
          <div className="stack">
            {SAMPLES.map((s) => (
              <label key={s.id} className="card-quiet card" style={{ cursor: "pointer", outline: sample === s.id ? "1px solid var(--c-ink)" : undefined }}>
                <div className="row" style={{ gap: 8 }}>
                  <input type="radio" name="sample" checked={sample === s.id} onChange={() => { setSample(s.id); setReflection(s.reflection); setTone(s.tone); }} />
                  <span>{s.label}</span>
                </div>
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  {s.files.map((f) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={f} src={`/api/studio/sample-thumbs?set=${s.id}&name=${f}`} alt="" width={72} height={96} style={{ objectFit: "cover", borderRadius: 6 }} />
                  ))}
                  <span className="small faint">{gate?.open && !gate.videos ? "（此活動未開放影片，範例影片會略過）" : "＋ 1 段影片"}</span>
                </div>
              </label>
            ))}
            <p className="small faint">範例素材是為測試繪製的合成插畫與影片，不是真實活動照片。</p>
          </div>
        ) : (
          <div className="stack">
            <input
              className="input"
              type="file"
              multiple
              accept={gate?.open && !gate.videos ? "image/jpeg,image/png,image/webp" : gate?.open && !gate.photos ? "video/mp4,video/quicktime,video/webm" : "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <p className="small faint">{STUDIO_LIMITS.MIN_FILES}–{STUDIO_LIMITS.MAX_FILES} 個檔案；照片 JPG／PNG／WebP，影片 MP4／MOV／WebM（90 秒內）。只上傳你自己拍攝、有權使用的素材。</p>
            {previews.length > 0 && (
              <div className="row wrap" style={{ gap: 6 }}>
                {previews.map((p) =>
                  p.type.startsWith("video/") ? (
                    <video key={p.url} src={p.url} muted width={72} height={96} style={{ objectFit: "cover", borderRadius: 6 }} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={p.url} src={p.url} alt={p.name} width={72} height={96} style={{ objectFit: "cover", borderRadius: 6 }} />
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="stack" style={{ marginTop: "var(--sp-5)" }}>
        <h2 className="h3">2・寫下一句你自己的話</h2>
        <div className="field">
          <textarea className="textarea" rows={3} value={reflection} onChange={(e) => setReflection(e.target.value)} placeholder="那一刻，你最想記住什麼？（可留白）" />
          <p className={`small mono ${graphemes > STUDIO_LIMITS.REFLECTION_MAX_GRAPHEMES ? "" : "faint"}`} style={graphemes > STUDIO_LIMITS.REFLECTION_MAX_GRAPHEMES ? { color: "var(--c-bad)" } : undefined}>
            {graphemes}／{STUDIO_LIMITS.REFLECTION_MAX_GRAPHEMES}
          </p>
          <p className="small faint">你的原文會一字不改地出現在影片中；AI 不會改寫它，也不會替你補上你沒寫的感受。</p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {TONES.map((t) => (
            <button key={t} className={`btn ${tone === t ? "btn-primary" : "btn-ghost"}`} onClick={() => setTone(t)} aria-pressed={tone === t}>{TONE_LABELS[t]}</button>
          ))}
        </div>
      </section>

      <section className="stack" style={{ marginTop: "var(--sp-5)" }}>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="small">我了解：素材的縮圖會傳送給 AI 服務（Anthropic Claude）分析畫面；原始檔只在這台伺服器暫存，{24} 小時內自動刪除，也可以隨時手動刪除；短片不會公開。</span>
        </label>
        {needCode && (
          <label className="stack">
            <span className="small">{accessCode ? "評審通行碼（已從連結帶入）" : "評審通行碼（即時產生需要；請見投稿表單中的測試說明）"}</span>
            <input className="input" type="password" autoComplete="off" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} />
          </label>
        )}
        <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
          {busy ? "上傳中…" : running ? "產生中…" : "產生我的記憶短片"}
        </button>
        {error && <p className="notice" data-tone="bad" role="alert">{error}</p>}
      </section>

      {job && (
        <section className="stack" style={{ marginTop: "var(--sp-6)" }} aria-live="polite">
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {STEPS.map((s) => {
              const order = ["queued", "analyzing", "planning", "rendering", "done"];
              const cur = order.indexOf(job.status === "failed" ? "queued" : job.status);
              const mine = order.indexOf(s.key);
              return <li key={s.key} className={mine < cur || job.status === "done" ? "" : mine === cur ? "" : "faint"}>{mine < cur || job.status === "done" ? "✓ " : mine === cur ? "… " : ""}{s.label}</li>;
            })}
          </ol>
          {job.status === "failed" && <p className="notice" data-tone="bad" role="alert">{job.error?.message ?? "產生失敗"}</p>}

          {job.status === "done" && (
            <div className="stack">
              <video controls playsInline src={`/api/studio/jobs/${job.id}/film`} style={{ width: "100%", maxWidth: 360, aspectRatio: "9 / 16", background: "#000", borderRadius: 12, alignSelf: "center" }} />
              <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                {job.download_allowed ? (
                  <a className="btn btn-primary" href={`/api/studio/jobs/${job.id}/film?download=1`}>下載短片（MP4）</a>
                ) : (
                  <span className="notice" data-tone="warn">此活動未開放下載</span>
                )}
                <button className="btn btn-ghost" onClick={remove}>刪除我的素材與短片</button>
              </div>
              <p className="small faint" style={{ textAlign: "center" }}>
                {job.render?.seconds} 秒・720×1280・以你的原始素材剪輯（FFmpeg）
              </p>
            </div>
          )}

          {job.storyboard && (
            <div className="card stack">
              <div className="row-between">
                <h3 className="h3" style={{ margin: 0 }}>{job.storyboard.title}</h3>
                <span className="chip" data-tone={job.plan_source === "claude" ? "ok" : "warn"}>
                  {job.plan_source === "claude" ? "AI 分鏡" : "AI 分鏡失敗・改用固定範本"}
                </span>
              </div>
              <p>{job.storyboard.narrative}</p>
              <table className="small" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr className="faint" style={{ textAlign: "left" }}><th>#</th><th>素材</th><th>秒數</th><th>字幕</th><th>依據</th></tr>
                </thead>
                <tbody>
                  {job.storyboard.shots.map((s, i) => {
                    const a = job.analysis?.find((x) => x.index === s.media_index);
                    const m = job.media.find((x) => x.index === s.media_index);
                    return (
                      <tr key={i} style={{ borderTop: "1px solid var(--c-line)", verticalAlign: "top" }}>
                        <td className="mono">{i + 1}</td>
                        <td>
                          {m?.type === "video" ? "影片" : "照片"} {s.media_index + 1}
                          {a && <div className="faint">AI 看到：{a.scene}</div>}
                        </td>
                        <td className="mono">{s.seconds}{m?.type === "video" && s.start_seconds > 0 ? ` @${s.start_seconds}` : ""}</td>
                        <td>{s.caption ?? <span className="faint">（無）</span>}</td>
                        <td className="faint">{GROUNDING[s.grounding] ?? s.grounding}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="small faint">你的原文卡片位置：{job.storyboard.reflection_after_shot === -1 ? "片尾前" : `第 ${job.storyboard.reflection_after_shot + 1} 個鏡頭之後`}・片尾：{job.storyboard.ending_text}</p>
            </div>
          )}

          {job.ai_calls.length > 0 && (
            <details className="card-quiet card">
              <summary className="small">AI 執行紀錄（{job.ai_calls.length}）</summary>
              <ul className="small mono" style={{ margin: "8px 0 0" }}>
                {job.ai_calls.map((c, i) => (
                  <li key={i}>{c.step}・{c.model}・{c.outcome}・{(c.latency_ms / 1000).toFixed(1)}s・in {c.input_tokens}/out {c.output_tokens}{c.request_id ? `・${c.request_id}` : ""}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      <p className="small faint" style={{ marginTop: "var(--sp-6)" }}>
        MEmory 用 AI 幫你整理你真實經歷過的片刻，而不是替你編造記憶。字幕只能根據畫面或你寫下的話；沒有根據時就不加字幕。
      </p>
    </main>
  );
}
