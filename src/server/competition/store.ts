import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { competitionConfig } from "./config";
import { writeJsonAtomic } from "./fsAtomic";
import type { MediaAnalysis, Storyboard, StudioMediaType, Tone } from "@/contracts/competition";
import type { AiCallRecord } from "./claude";

export type JobStatus = "queued" | "analyzing" | "planning" | "rendering" | "done" | "failed";

export interface JobMedia {
  index: number;
  file: string;
  type: StudioMediaType;
  mime: string;
  bytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

export interface JobRecord {
  id: string;
  created_at: string;
  updated_at: string;
  status: JobStatus;
  sample_set: string | null;
  event_id: string;
  event_name: string;
  tone: Tone;
  reflection: string;
  media: JobMedia[];
  analysis: MediaAnalysis[] | null;
  analysis_source: "claude" | null;
  storyboard: Storyboard | null;
  plan_source: "claude" | "template" | null;
  plan_repairs: string[];
  ai_calls: AiCallRecord[];
  render: { started_at: string; finished_at: string | null; seconds: number | null; bytes: number | null; renderer: "ffmpeg-local" } | null;
  error: { code: string; message: string } | null;
  download_allowed: boolean;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function jobsRoot(): string {
  return path.join(competitionConfig().dataDir, "jobs");
}
export function jobDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error("invalid job id");
  return path.join(jobsRoot(), id);
}

export async function createJobDir(): Promise<string> {
  const id = randomUUID();
  await mkdir(path.join(jobDir(id), "media"), { recursive: true });
  return id;
}

export async function saveJob(job: JobRecord): Promise<void> {
  job.updated_at = new Date().toISOString();
  await writeJsonAtomic(path.join(jobDir(job.id), "job.json"), job);
}

export async function loadJob(id: string): Promise<JobRecord | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(jobDir(id), "job.json"), "utf8")) as JobRecord;
  } catch {
    return null;
  }
}

export async function deleteJob(id: string): Promise<void> {
  if (!ID_RE.test(id)) return;
  await rm(jobDir(id), { recursive: true, force: true });
}

export function filmPath(id: string): string {
  return path.join(jobDir(id), "film.mp4");
}

/** Delete jobs older than the TTL (private media is never kept indefinitely). */
export async function sweepExpiredJobs(): Promise<number> {
  const ttlMs = competitionConfig().jobTtlHours * 3600_000;
  let removed = 0;
  let names: string[] = [];
  try {
    names = await readdir(jobsRoot());
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!ID_RE.test(n)) continue;
    try {
      const s = await stat(path.join(jobsRoot(), n));
      if (Date.now() - s.mtimeMs > ttlMs) {
        await rm(path.join(jobsRoot(), n), { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/** Public projection: no file paths, no request ids beyond what evidence needs. */
export function publicJob(job: JobRecord) {
  return {
    id: job.id,
    status: job.status,
    created_at: job.created_at,
    sample_set: job.sample_set,
    event_name: job.event_name,
    tone: job.tone,
    reflection: job.reflection,
    media: job.media.map((m) => ({ index: m.index, type: m.type, duration_seconds: m.durationSeconds })),
    analysis: job.analysis,
    analysis_source: job.analysis_source,
    storyboard: job.storyboard,
    plan_source: job.plan_source,
    plan_repairs: job.plan_repairs,
    ai_calls: job.ai_calls.map((c) => ({
      step: c.step,
      model: c.model,
      request_id: c.request_id,
      latency_ms: c.latency_ms,
      input_tokens: c.input_tokens,
      output_tokens: c.output_tokens,
      outcome: c.outcome,
    })),
    render: job.render,
    error: job.error,
    download_allowed: job.download_allowed,
  };
}
