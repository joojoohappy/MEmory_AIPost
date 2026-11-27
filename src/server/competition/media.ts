import "server-only";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { competitionConfig } from "./config";

const run = promisify(execFile);

export interface Probe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  formatName: string | null;
}

/** Trusted probe of a stored file (never the browser's metadata). */
export async function probeFile(file: string): Promise<Probe | null> {
  try {
    const { stdout } = await run(
      competitionConfig().ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const j = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string };
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }[];
    };
    const v = j.streams?.find((s) => s.codec_type === "video");
    const a = j.streams?.find((s) => s.codec_type === "audio");
    const dur = Number(j.format?.duration ?? v?.duration);
    return {
      durationSeconds: Number.isFinite(dur) && dur > 0 ? dur : null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      hasVideo: Boolean(v),
      hasAudio: Boolean(a),
      videoCodec: v?.codec_name ?? null,
      formatName: j.format?.format_name ?? null,
    };
  } catch {
    return null;
  }
}

/** Downscaled JPEG (long edge 1024) for the vision model — keeps requests small. */
export async function analysisStill(input: string, outDir: string, name: string, atSeconds: number | null): Promise<Buffer> {
  const out = path.join(outDir, `${name}.jpg`);
  const args = ["-y", "-v", "error"];
  if (atSeconds !== null) args.push("-ss", atSeconds.toFixed(2));
  args.push(
    "-i", input,
    "-frames:v", "1",
    "-vf", "scale='if(gt(iw,ih),min(1024,iw),-2)':'if(gt(iw,ih),-2,min(1024,ih))'",
    "-q:v", "4",
    out,
  );
  await run(competitionConfig().ffmpeg, args, { timeout: 60_000 });
  return readFile(out);
}

/** Frame times offered to the model for a video (it picks the strongest start). */
export function sampleTimes(duration: number): number[] {
  if (duration <= 3) return [0];
  const pts = [0.1, 0.45, 0.8].map((f) => Math.round(duration * f * 10) / 10);
  return [...new Set(pts)];
}
