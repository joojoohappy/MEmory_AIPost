import { z } from "zod";
import { countGraphemes } from "./reflection";

/**
 * Competition build contracts (OPEN LAB AI Build Challenge, competition/SCOPE.md).
 * A compact, stateless "memory studio" flow that reuses the product's planning rules:
 * the user's reflection is never rewritten (shown verbatim on its own card), the model only
 * proposes order / durations / short captions grounded in what it observed or what the user
 * wrote, and the server validates everything before rendering.
 */

export const STUDIO_LIMITS = {
  MIN_FILES: 2,
  MAX_FILES: 8,
  MAX_FILE_BYTES: 60_000_000,
  MAX_TOTAL_BYTES: 240_000_000,
  MAX_VIDEO_INPUT_SECONDS: 90,
  MAX_VIDEO_SHOT_SECONDS: 8,
  MIN_SHOT_SECONDS: 2,
  MAX_PHOTO_SECONDS: 6,
  MAX_FILM_SECONDS: 45,
  REFLECTION_MAX_GRAPHEMES: 80,
  CAPTION_MAX_GRAPHEMES: 22,
  TITLE_MAX_GRAPHEMES: 24,
  NARRATIVE_MAX_GRAPHEMES: 220,
  TITLE_CARD_SECONDS: 2.5,
  REFLECTION_CARD_SECONDS: 4,
  END_CARD_SECONDS: 2.5,
} as const;

export const TONES = ["gentle", "bright", "quiet"] as const;
export type Tone = (typeof TONES)[number];
export const TONE_LABELS: Record<Tone, string> = { gentle: "溫柔回望", bright: "熱烈明亮", quiet: "安靜留白" };
/** Tone → existing CCD effect recipe (src/design/effects.ts) and pacing. */
export const TONE_FILTER: Record<Tone, "ccd_warm" | "ccd_neutral" | "ccd_cool"> = {
  gentle: "ccd_warm",
  bright: "ccd_neutral",
  quiet: "ccd_cool",
};

export type StudioMediaType = "photo" | "video";
export const STUDIO_MIME: Record<StudioMediaType, readonly string[]> = {
  photo: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4", "video/quicktime", "video/webm"],
};
export function studioMediaType(mime: string): StudioMediaType | null {
  const m = mime.toLowerCase().split(";")[0]!.trim();
  if (STUDIO_MIME.photo.includes(m)) return "photo";
  if (STUDIO_MIME.video.includes(m)) return "video";
  return null;
}

// ---------------------------------------------------------------- analysis
export const mediaAnalysisSchema = z.object({
  index: z.number().int().min(0),
  scene: z.string().min(1).max(400),
  visible_elements: z.array(z.string().max(60)).max(10),
  lighting: z.string().max(80),
  energy: z.enum(["calm", "medium", "high"]),
  people_visible: z.boolean(),
  /** Only for video: which offered frame time (seconds) is the strongest start point. */
  best_start_seconds: z.number().min(0).nullable(),
});
export type MediaAnalysis = z.infer<typeof mediaAnalysisSchema>;

export const analysisResultSchema = z.object({ items: z.array(mediaAnalysisSchema).min(1) });

export const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "scene", "visible_elements", "lighting", "energy", "people_visible", "best_start_seconds"],
        properties: {
          index: { type: "integer", description: "素材編號（與輸入相同）" },
          scene: { type: "string", description: "繁體中文，只描述畫面中看得到的內容，1–2 句" },
          visible_elements: { type: "array", items: { type: "string" }, description: "看得到的元素，最多 8 個" },
          lighting: { type: "string", description: "光線與色調，簡短" },
          energy: { type: "string", enum: ["calm", "medium", "high"] },
          people_visible: { type: "boolean", description: "畫面中是否有人（不辨識身分）" },
          best_start_seconds: {
            type: ["number", "null"],
            description: "只限影片：從提供的影格時間中選最適合作為片段起點的秒數；照片填 null",
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------- storyboard
export const storyShotSchema = z.object({
  media_index: z.number().int().min(0),
  seconds: z.number().positive(),
  start_seconds: z.number().min(0),
  caption: z.string().nullable(),
  grounding: z.enum(["visual", "reflection", "event", "none"]),
});
export type StoryShot = z.infer<typeof storyShotSchema>;

export const storyboardSchema = z.object({
  title: z.string().min(1),
  narrative: z.string().min(1),
  shots: z.array(storyShotSchema).min(1),
  reflection_after_shot: z.number().int().min(-1),
  ending_text: z.string().min(1),
});
export type Storyboard = z.infer<typeof storyboardSchema>;

export const STORYBOARD_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "narrative", "shots", "reflection_after_shot", "ending_text"],
  properties: {
    title: { type: "string", description: "繁中片名，最多 24 字，不含網址" },
    narrative: { type: "string", description: "繁中短敘事，最多 200 字，只根據畫面觀察與使用者原文" },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["media_index", "seconds", "start_seconds", "caption", "grounding"],
        properties: {
          media_index: { type: "integer" },
          seconds: { type: "number" },
          start_seconds: { type: "number", description: "影片起點秒數；照片填 0" },
          caption: { type: ["string", "null"], description: "畫面字幕，最多 20 字；沒有根據就填 null" },
          grounding: { type: "string", enum: ["visual", "reflection", "event", "none"] },
        },
      },
    },
    reflection_after_shot: { type: "integer", description: "使用者原文卡片放在第幾個鏡頭之後（0 起算；-1 表示放在片尾前）" },
    ending_text: { type: "string", description: "繁中片尾，最多 24 字，中性" },
  },
} as const;

export interface StudioMediaInfo {
  index: number;
  type: StudioMediaType;
  durationSeconds: number | null;
}

const UNSAFE = /[<>]|https?:|www\.|javascript:/i;

function textOk(t: string, max: number): boolean {
  const g = countGraphemes(t.trim());
  return g >= 1 && g <= max && !UNSAFE.test(t);
}

export function shotBounds(m: StudioMediaInfo): { min: number; max: number } {
  if (m.type === "photo") return { min: STUDIO_LIMITS.MIN_SHOT_SECONDS, max: STUDIO_LIMITS.MAX_PHOTO_SECONDS };
  const d = m.durationSeconds ?? 0;
  return { min: Math.min(STUDIO_LIMITS.MIN_SHOT_SECONDS, d), max: Math.min(STUDIO_LIMITS.MAX_VIDEO_SHOT_SECONDS, d) };
}

export function storyboardTotal(sb: Pick<Storyboard, "shots">, hasReflection: boolean): number {
  const shots = sb.shots.reduce((s, x) => s + x.seconds, 0);
  const cards =
    STUDIO_LIMITS.TITLE_CARD_SECONDS + STUDIO_LIMITS.END_CARD_SECONDS + (hasReflection ? STUDIO_LIMITS.REFLECTION_CARD_SECONDS : 0);
  return Math.round((shots + cards) * 10) / 10;
}

export type StoryboardValidation = { ok: true; storyboard: Storyboard; repaired: string[] } | { ok: false; reasons: string[] };

/**
 * Validate (and conservatively repair) a model storyboard against the actual media.
 * Hard failures: schema, unknown/duplicate media, missing media, unsafe title text.
 * Repairs (recorded, never silent): clamp durations, drop over-long/unsafe captions,
 * clamp video start so the shot fits, shrink to the 45 s budget.
 */
export function validateStoryboard(candidate: unknown, media: StudioMediaInfo[], hasReflection: boolean): StoryboardValidation {
  const parsed = storyboardSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reasons: ["schema"] };
  const sb = structuredClone(parsed.data);
  const reasons: string[] = [];
  const repaired: string[] = [];
  const seen = new Set<number>();
  for (const [i, shot] of sb.shots.entries()) {
    const m = media.find((x) => x.index === shot.media_index);
    if (!m) {
      reasons.push(`unknown_media:${i}`);
      continue;
    }
    if (seen.has(shot.media_index)) reasons.push(`duplicate_media:${i}`);
    seen.add(shot.media_index);
    const b = shotBounds(m);
    const clamped = Math.round(Math.min(b.max, Math.max(b.min, shot.seconds)) * 10) / 10;
    if (clamped !== shot.seconds) repaired.push(`seconds:${i}`);
    shot.seconds = clamped;
    if (m.type === "photo") {
      shot.start_seconds = 0;
    } else {
      const maxStart = Math.max(0, (m.durationSeconds ?? 0) - shot.seconds);
      if (shot.start_seconds > maxStart) {
        shot.start_seconds = Math.floor(maxStart * 10) / 10;
        repaired.push(`start:${i}`);
      }
    }
    if (shot.caption !== null && !textOk(shot.caption, STUDIO_LIMITS.CAPTION_MAX_GRAPHEMES)) {
      shot.caption = null;
      repaired.push(`caption_dropped:${i}`);
    }
    if (shot.caption === null) shot.grounding = "none";
  }
  if (seen.size !== media.length) reasons.push("missing_media");
  if (!textOk(sb.title, STUDIO_LIMITS.TITLE_MAX_GRAPHEMES)) reasons.push("title");
  if (!textOk(sb.ending_text, STUDIO_LIMITS.TITLE_MAX_GRAPHEMES)) reasons.push("ending_text");
  if (!textOk(sb.narrative, STUDIO_LIMITS.NARRATIVE_MAX_GRAPHEMES)) reasons.push("narrative");
  if (reasons.length) return { ok: false, reasons };
  if (sb.reflection_after_shot >= sb.shots.length || sb.reflection_after_shot < -1) {
    sb.reflection_after_shot = -1;
    repaired.push("reflection_position");
  }
  // Fit into the film budget: shorten the longest shots first, never below the minimum.
  let guard = 200;
  while (storyboardTotal(sb, hasReflection) > STUDIO_LIMITS.MAX_FILM_SECONDS && guard-- > 0) {
    const longest = sb.shots.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    if (longest.seconds <= STUDIO_LIMITS.MIN_SHOT_SECONDS) break;
    longest.seconds = Math.round((longest.seconds - 0.5) * 10) / 10;
    if (!repaired.includes("budget")) repaired.push("budget");
  }
  if (storyboardTotal(sb, hasReflection) > STUDIO_LIMITS.MAX_FILM_SECONDS) return { ok: false, reasons: ["total_duration"] };
  return { ok: true, storyboard: sb, repaired };
}

/**
 * Deterministic fallback used ONLY when the AI step fails. It is labelled plan_source="template"
 * in the job record and UI, invents no captions, and keeps upload order.
 */
export function templateStoryboard(media: StudioMediaInfo[], eventName: string): Storyboard {
  const shots: StoryShot[] = media.map((m) => ({
    media_index: m.index,
    seconds: m.type === "photo" ? 4 : Math.min(6, m.durationSeconds ?? 4),
    start_seconds: 0,
    caption: null,
    grounding: "none",
  }));
  const title = textOk(eventName, STUDIO_LIMITS.TITLE_MAX_GRAPHEMES) ? eventName : "我的現場記憶";
  const res = validateStoryboard(
    { title, narrative: "依照你上傳的順序剪輯，未加入 AI 字幕。", shots, reflection_after_shot: -1, ending_text: "你留下的這一天" },
    media,
    true,
  );
  if (!res.ok) throw new Error(`template storyboard invalid: ${res.reasons.join(",")}`);
  return res.storyboard;
}

export function validateReflection(text: string): { ok: true; text: string } | { ok: false; code: "REFLECTION_TOO_LONG" | "REFLECTION_UNSAFE" } {
  const t = text.trim();
  if (countGraphemes(t) > STUDIO_LIMITS.REFLECTION_MAX_GRAPHEMES) return { ok: false, code: "REFLECTION_TOO_LONG" };
  if (/[<>]/.test(t)) return { ok: false, code: "REFLECTION_UNSAFE" };
  return { ok: true, text: t };
}
