import "server-only";
import { copyFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STUDIO_LIMITS,
  TONES,
  studioMediaType,
  validateReflection,
  type StudioMediaType,
  type Tone,
} from "@/contracts/competition";
import { studioGate } from "@/contracts/competitionEvent";
import { sniffImage } from "@/server/media/probe";
import { loadActiveEvent } from "./event";
import { probeFile } from "./media";
import { createJobDir, deleteJob, jobDir, saveJob, sweepExpiredJobs, type JobMedia, type JobRecord } from "./store";

export const SAMPLE_SETS = ["night-concert", "day-fair"] as const;
export type SampleSet = (typeof SAMPLE_SETS)[number];
export const SAMPLES_ROOT = path.join(process.cwd(), "samples", "competition");

/**
 * Spend guard for a public demo: a global daily job cap and a per-client hourly cap, both in
 * memory (single instance). Defaults: 80 jobs/day, 6 jobs/hour per client.
 */
const usage = ((globalThis as unknown as { __studioUsage?: { day: string; count: number; perClient: Map<string, number[]> } }).__studioUsage ??= {
  day: "",
  count: 0,
  perClient: new Map(),
});
export function checkSpendGuard(clientKey: string, now = Date.now()): string | null {
  const day = new Date(now).toISOString().slice(0, 10);
  if (usage.day !== day) {
    usage.day = day;
    usage.count = 0;
  }
  const dailyCap = Number(process.env.COMPETITION_DAILY_JOB_CAP || 80);
  const hourlyCap = Number(process.env.COMPETITION_CLIENT_HOURLY_CAP || 6);
  if (usage.count >= dailyCap) return "DAILY_CAP_REACHED";
  const recent = (usage.perClient.get(clientKey) ?? []).filter((t: number) => now - t < 3600_000);
  if (recent.length >= hourlyCap) return "RATE_LIMITED";
  recent.push(now);
  usage.perClient.set(clientKey, recent);
  usage.count++;
  return null;
}

export class IntakeError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

interface Incoming {
  name: string;
  mime: string;
  bytes: number;
  write: (dest: string) => Promise<void>;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
};

function mimeFromName(n: string): string {
  const e = n.toLowerCase().split(".").pop();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", mp4: "video/mp4" } as Record<string, string>)[e ?? ""] ?? "";
}

export async function sampleFiles(set: SampleSet): Promise<Incoming[]> {
  const dir = path.join(SAMPLES_ROOT, set);
  const names = (await readdir(dir)).filter((n) => /\.(jpe?g|png|mp4)$/i.test(n)).sort();
  return names.map((n) => ({
    name: n,
    mime: mimeFromName(n),
    bytes: 1,
    write: (dest: string) => copyFile(path.join(dir, n), dest),
  }));
}

export function formFiles(files: File[]): Incoming[] {
  return files.map((f) => ({
    name: f.name,
    mime: f.type,
    bytes: f.size,
    write: async (dest: string) => writeFile(dest, Buffer.from(await f.arrayBuffer())),
  }));
}

/**
 * Validate, store and probe the inputs, then create the job record. Every check is re-done on
 * the stored bytes (magic bytes / ffprobe), never trusting the browser's type or size.
 */
export async function createStudioJob(input: {
  files: Incoming[];
  reflection: string;
  tone: string;
  consent: boolean;
  sampleSet: SampleSet | null;
  clientKey?: string;
}): Promise<JobRecord> {
  void sweepExpiredJobs();
  const event = await loadActiveEvent();
  const gate = studioGate(event, new Date());
  if (!gate.open) throw new IntakeError(`STUDIO_CLOSED_${gate.reason.toUpperCase()}`, 403);
  if (!input.consent) throw new IntakeError("CONSENT_REQUIRED");
  if (!TONES.includes(input.tone as Tone)) throw new IntakeError("TONE_INVALID");
  const limited = checkSpendGuard(input.clientKey ?? "local");
  if (limited) throw new IntakeError(limited, 429);
  const refl = validateReflection(input.reflection ?? "");
  if (!refl.ok) throw new IntakeError(refl.code);
  // Sample sets follow the active event policy: media types the organizer did not permit are left out.
  if (input.sampleSet) {
    input.files = input.files.filter((f) => {
      const t = studioMediaType(f.mime);
      return (t === "photo" && gate.photos) || (t === "video" && gate.videos);
    });
  }
  const n = input.files.length;
  if (n < STUDIO_LIMITS.MIN_FILES) throw new IntakeError("TOO_FEW_FILES");
  if (n > STUDIO_LIMITS.MAX_FILES) throw new IntakeError("TOO_MANY_FILES");
  const total = input.files.reduce((s, f) => s + f.bytes, 0);
  if (total > STUDIO_LIMITS.MAX_TOTAL_BYTES) throw new IntakeError("PAYLOAD_TOO_LARGE", 413);

  const id = await createJobDir();
  try {
    const media: JobMedia[] = [];
    for (const [i, f] of input.files.entries()) {
      if (f.bytes > STUDIO_LIMITS.MAX_FILE_BYTES) throw new IntakeError("FILE_TOO_LARGE", 413);
      const declared = studioMediaType(f.mime);
      if (!declared) throw new IntakeError("MEDIA_UNSUPPORTED");
      if (declared === "photo" && !gate.photos) throw new IntakeError("PHOTOS_NOT_PERMITTED", 403);
      if (declared === "video" && !gate.videos) throw new IntakeError("VIDEOS_NOT_PERMITTED", 403);
      const file = `m${i}.${EXT[f.mime.toLowerCase().split(";")[0]!.trim()] ?? "bin"}`;
      const dest = path.join(jobDir(id), "media", file);
      await f.write(dest);
      const probe = await probeFile(dest);
      let type: StudioMediaType = declared;
      if (declared === "photo") {
        const { readFile } = await import("node:fs/promises");
        const head = (await readFile(dest)).subarray(0, 64 * 1024);
        const sniff = sniffImage(head);
        if (!sniff || sniff.mime === "image/heic") throw new IntakeError("MEDIA_UNSUPPORTED");
        if (!probe) throw new IntakeError("MEDIA_UNSUPPORTED");
      } else {
        if (!probe?.hasVideo || !probe.durationSeconds) throw new IntakeError("MEDIA_UNSUPPORTED");
        if (probe.durationSeconds > STUDIO_LIMITS.MAX_VIDEO_INPUT_SECONDS) throw new IntakeError("VIDEO_TOO_LONG");
        type = "video";
      }
      media.push({
        index: i,
        file,
        type,
        mime: f.mime,
        bytes: f.bytes,
        durationSeconds: type === "video" ? Math.round(probe!.durationSeconds! * 10) / 10 : null,
        width: probe?.width ?? null,
        height: probe?.height ?? null,
        hasAudio: Boolean(probe?.hasAudio),
      });
    }
    const now = new Date().toISOString();
    const job: JobRecord = {
      id,
      created_at: now,
      updated_at: now,
      status: "queued",
      sample_set: input.sampleSet,
      event_id: event.id,
      event_name: event.name,
      tone: input.tone as Tone,
      reflection: refl.text,
      media,
      analysis: null,
      analysis_source: null,
      storyboard: null,
      plan_source: null,
      plan_repairs: [],
      ai_calls: [],
      render: null,
      error: null,
      download_allowed: gate.download,
    };
    await saveJob(job);
    return job;
  } catch (err) {
    await deleteJob(id);
    throw err;
  }
}
