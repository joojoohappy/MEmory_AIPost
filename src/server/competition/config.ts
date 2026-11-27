import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Competition-build configuration. Deliberately independent of src/server/env.ts so the studio
 * and organizer agent run without the beta's Postgres/Clerk/R2 stack. Secrets are read from the
 * environment only and never sent to the browser or written to job records/evidence.
 */
export interface CompetitionConfig {
  aiMode: "claude" | "unavailable";
  anthropicKey: string | null;
  visionModel: string;
  storyModel: string;
  fallbackModel: string;
  compdfKey: string | null;
  compdfBaseUrl: string;
  dataDir: string;
  fontPath: string | null;
  ffmpeg: string;
  ffprobe: string;
  jobTtlHours: number;
  organizerToken: string | null;
  /** When set, live generation (paid AI calls) requires this code in the x-studio-access header. */
  studioAccessCode: string | null;
}

const FONT_CANDIDATES = [
  process.env.COMPETITION_FONT_PATH,
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",
  "C:\\Windows\\Fonts\\msjh.ttc",
];

export function competitionConfig(): CompetitionConfig {
  const key = process.env.ANTHROPIC_API_KEY?.trim() || null;
  const font = FONT_CANDIDATES.find((p): p is string => Boolean(p) && existsSync(p as string)) ?? null;
  return {
    aiMode: key ? "claude" : "unavailable",
    anthropicKey: key,
    visionModel: process.env.COMPETITION_VISION_MODEL || "claude-opus-5-5",
    storyModel: process.env.COMPETITION_STORY_MODEL || "claude-opus-5-5",
    fallbackModel: process.env.COMPETITION_FALLBACK_MODEL || "claude-sonnet-5-5",
    compdfKey: process.env.COMPDF_API_KEY?.trim() || process.env.COMPDF_PUBLIC_KEY?.trim() || null,
    compdfBaseUrl: process.env.COMPDF_API_BASE_URL || "https://api-server.compdf.com/server",
    dataDir: path.resolve(process.env.COMPETITION_DATA_DIR || path.join(process.cwd(), ".competition-data")),
    fontPath: font,
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
    jobTtlHours: Number(process.env.COMPETITION_JOB_TTL_HOURS || 24),
    organizerToken: process.env.ORGANIZER_ACCESS_TOKEN?.trim() || null,
    studioAccessCode: process.env.STUDIO_ACCESS_CODE?.trim() || null,
  };
}
