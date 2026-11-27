import "server-only";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { templateStoryboard, type StudioMediaInfo } from "@/contracts/competition";
import { analyzeMedia, planStoryboard } from "./ai";
import { AiUnavailableError } from "./claude";
import { competitionConfig } from "./config";
import { loadActiveEvent } from "./event";
import { renderFilm } from "./render";
import { filmPath, jobDir, loadJob, saveJob, type JobRecord } from "./store";

const running = ((globalThis as unknown as { __memoryStudioRunning?: Set<string> }).__memoryStudioRunning ??= new Set());

/** Append a sanitized execution line to the evidence log (no media, no text, no keys). */
async function evidence(line: Record<string, unknown>): Promise<void> {
  const dir = path.join(competitionConfig().dataDir, "evidence");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "ai-calls.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
}

export function startJob(id: string): void {
  if (running.has(id)) return;
  running.add(id);
  void runJob(id).finally(() => running.delete(id));
}

async function fail(job: JobRecord, code: string, message: string): Promise<void> {
  job.status = "failed";
  job.error = { code, message };
  await saveJob(job);
  await evidence({ job: job.id, kind: "job_failed", code });
}

export async function runJob(id: string): Promise<void> {
  const job = await loadJob(id);
  if (!job || job.status === "done") return;
  const dir = jobDir(id);
  const event = await loadActiveEvent();
  const info: StudioMediaInfo[] = job.media.map((m) => ({ index: m.index, type: m.type, durationSeconds: m.durationSeconds }));
  try {
    // 1) multimodal understanding — required; the studio never pretends AI ran.
    job.status = "analyzing";
    await saveJob(job);
    const a = await analyzeMedia(job.media, dir);
    job.ai_calls.push(...a.calls);
    for (const c of a.calls) await evidence({ job: id, sample_set: job.sample_set, ...c });
    if (!a.analysis) return fail(job, "AI_ANALYSIS_FAILED", "AI 素材理解失敗，請稍後再試。");
    job.analysis = a.analysis;
    job.analysis_source = "claude";

    // 2) narrative + storyboard (AI), template fallback is labelled
    job.status = "planning";
    await saveJob(job);
    const p = await planStoryboard({ event, media: info, analysis: a.analysis, reflection: job.reflection, tone: job.tone });
    job.ai_calls.push(...p.calls);
    for (const c of p.calls) await evidence({ job: id, sample_set: job.sample_set, ...c });
    if (p.storyboard) {
      job.storyboard = p.storyboard;
      job.plan_source = "claude";
      job.plan_repairs = p.repairs;
    } else {
      job.storyboard = templateStoryboard(info, event.name);
      job.plan_source = "template";
      job.plan_repairs = p.repairs;
    }

    // 3) deterministic render with the original media
    job.status = "rendering";
    job.render = { started_at: new Date().toISOString(), finished_at: null, seconds: null, bytes: null, renderer: "ffmpeg-local" };
    await saveJob(job);
    const r = await renderFilm({
      workDir: dir,
      media: job.media,
      storyboard: job.storyboard,
      reflection: job.reflection,
      eventName: job.event_name,
      tone: job.tone,
      out: filmPath(id),
    });
    job.render = { ...job.render, finished_at: new Date().toISOString(), seconds: r.seconds, bytes: r.bytes };
    job.status = "done";
    await saveJob(job);
    await evidence({ job: id, sample_set: job.sample_set, kind: "render_done", seconds: r.seconds, bytes: r.bytes, plan_source: job.plan_source });
  } catch (err) {
    if (err instanceof AiUnavailableError) return fail(job, "AI_NOT_CONFIGURED", "AI 服務尚未設定，無法產生記憶短片。");
    console.error("[studio] job failed", id, err instanceof Error ? err.message.slice(0, 300) : "unknown");
    return fail(job, "GENERATION_FAILED", "產生短片時發生錯誤，你的素材沒有被公開，請重試或換一組素材。");
  }
}
