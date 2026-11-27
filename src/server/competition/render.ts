import "server-only";
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { STUDIO_LIMITS, TONE_FILTER, type Storyboard, type Tone } from "@/contracts/competition";
import { EFFECT_RECIPES } from "@/design/effects";
import { competitionConfig } from "./config";
import type { JobMedia } from "./store";

const run = promisify(execFile);

/**
 * Deterministic FFmpeg renderer for the competition build (RENDERER = "ffmpeg-local").
 * It edits the user's ORIGINAL media per the validated storyboard: 720×1280 H.264/AAC,
 * blurred-fill framing (nothing is cropped away), slow push-in on photos, original video
 * audio, the existing CCD effect recipe as a flat overlay, captions, and three text cards
 * (title, the user's reflection verbatim, ending). No generative video is used.
 */

const W = 720;
const H = 1280;
const FPS = 30;
const V_ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const A_ENC = ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"];

let segmenter: Intl.Segmenter | null = null;
function graphemes(s: string): string[] {
  segmenter ??= new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/**
 * Wrap text for drawtext: CJK ≈ 1 unit, ASCII ≈ 0.55 unit per grapheme. Lines are balanced
 * (no single orphan character on the last line) and every character is kept.
 */
export function wrapText(text: string, unitsPerLine: number): string {
  const unit = (g: string) => (/^[\x20-\x7e]$/.test(g) ? 0.55 : 1);
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const gs = graphemes(para);
    const total = gs.reduce((s, g) => s + unit(g), 0);
    const count = Math.max(1, Math.ceil(total / unitsPerLine));
    const target = Math.min(unitsPerLine, total / count + 0.5);
    let line = "";
    let units = 0;
    for (const g of gs) {
      const u = unit(g);
      if (units + u > target && line && lines.length < 50) {
        // keep closing punctuation with the previous line
        if (/^[，。、！？；：」』）,.!?)]$/.test(g) && units + u <= unitsPerLine) {
          line += g;
          lines.push(line.trimEnd());
          line = "";
          units = 0;
          continue;
        }
        lines.push(line.trimEnd());
        line = "";
        units = 0;
        if (g === " ") continue;
      }
      line += g;
      units += u;
    }
    if (line) lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

function filterEsc(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function tintFilter(tone: Tone): string {
  const recipe = EFFECT_RECIPES[TONE_FILTER[tone]];
  if (!recipe.overlay) return "null";
  return `drawbox=x=0:y=0:w=iw:h=ih:color=0x${recipe.overlay.color.slice(1)}@${recipe.overlay.opacity}:t=fill`;
}

async function ff(args: string[], timeoutMs = 180_000): Promise<void> {
  await run(competitionConfig().ffmpeg, ["-y", "-v", "error", "-nostdin", ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

function textDraw(textFile: string, opts: { size: number; y: string; color?: string; box?: boolean; fadeIn?: number }): string {
  const font = competitionConfig().fontPath;
  if (!font) throw new Error("no CJK font available (set COMPETITION_FONT_PATH)");
  const parts = [
    `fontfile='${filterEsc(font)}'`,
    `textfile='${filterEsc(textFile)}'`,
    "expansion=none",
    `fontsize=${opts.size}`,
    `fontcolor=${opts.color ?? "0xEDEAE3"}`,
    `line_spacing=${Math.round(opts.size * 0.35)}`,
    "x=(w-text_w)/2",
    `y=${opts.y}`,
  ];
  if (opts.box) parts.push("box=1", "boxcolor=0x050506@0.55", `boxborderw=${Math.round(opts.size * 0.5)}`);
  if (opts.fadeIn) parts.push(`alpha='min(1,t/${opts.fadeIn})'`);
  return `drawtext=${parts.join(":")}`;
}

const fades = (s: number) => `fade=t=in:st=0:d=0.35,fade=t=out:st=${Math.max(0, s - 0.35).toFixed(2)}:d=0.35`;
const afades = (s: number) => `afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0, s - 0.4).toFixed(2)}:d=0.4`;

async function cardSegment(out: string, seconds: number, layers: { file: string; size: number; y: string; color?: string }[]): Promise<void> {
  const vf = [
    "format=yuv420p",
    ...layers.map((l) => textDraw(l.file, { size: l.size, y: l.y, color: l.color, fadeIn: 0.6 })),
    fades(seconds),
  ].join(",");
  await ff([
    "-f", "lavfi", "-i", `color=c=0x050506:s=${W}x${H}:r=${FPS}:d=${seconds}`,
    "-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=48000:cl=stereo",
    "-vf", vf, ...V_ENC, ...A_ENC, "-t", String(seconds), "-shortest", out,
  ]);
}

async function shotSegment(
  out: string,
  m: JobMedia,
  src: string,
  seconds: number,
  start: number,
  captionFile: string | null,
  tone: Tone,
): Promise<void> {
  const frames = Math.round(seconds * FPS);
  const compose =
    `split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.12[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  const post = [
    tintFilter(tone),
    captionFile ? textDraw(captionFile, { size: 40, y: "h-text_h-210", box: true, fadeIn: 0.5 }) : "null",
    fades(seconds),
    "format=yuv420p",
  ].join(",");
  if (m.type === "photo") {
    const zoom =
      `scale=${W * 2}:${H * 2},zoompan=z='min(1+0.0009*on,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`;
    await ff([
      "-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", src,
      "-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=48000:cl=stereo",
      "-filter_complex", `[0:v]${compose},${zoom},${post}[v]`,
      "-map", "[v]", "-map", "1:a", "-frames:v", String(frames), ...V_ENC, ...A_ENC, "-t", String(seconds), out,
    ]);
    return;
  }
  const audioIn = m.hasAudio
    ? ["-filter_complex", `[0:v]fps=${FPS},${compose},${post}[v];[0:a]aresample=48000,aformat=channel_layouts=stereo,${afades(seconds)}[a]`, "-map", "[v]", "-map", "[a]"]
    : ["-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=48000:cl=stereo",
       "-filter_complex", `[0:v]fps=${FPS},${compose},${post}[v]`, "-map", "[v]", "-map", "1:a"];
  // input seek (-ss before -i) resets timestamps to 0 for the fades
  const args = ["-ss", start.toFixed(2), "-t", String(seconds), "-i", src];
  if (m.hasAudio) args.push(...audioIn);
  else args.push(...audioIn);
  args.push(...V_ENC, ...A_ENC, "-t", String(seconds), out);
  await ff(args);
}

export async function renderFilm(input: {
  workDir: string;
  media: JobMedia[];
  storyboard: Storyboard;
  reflection: string;
  eventName: string;
  tone: Tone;
  out: string;
}): Promise<{ seconds: number; bytes: number }> {
  const { workDir, storyboard: sb } = input;
  const segDir = path.join(workDir, "segments");
  await mkdir(segDir, { recursive: true });
  const txt = async (name: string, content: string) => {
    const f = path.join(segDir, `${name}.txt`);
    await writeFile(f, content, "utf8");
    return f;
  };
  const segments: string[] = [];
  let n = 0;
  const next = () => path.join(segDir, `${String(n++).padStart(2, "0")}.mp4`);

  // Title card
  const title = next();
  await cardSegment(title, STUDIO_LIMITS.TITLE_CARD_SECONDS, [
    { file: await txt("event", wrapText(input.eventName, 20)), size: 30, y: "h*0.40-text_h", color: "0xB4B0A6" },
    { file: await txt("title", wrapText(sb.title, 12)), size: 58, y: "h*0.44" },
  ]);
  segments.push(title);

  const reflectionCard = async () => {
    if (!input.reflection) return;
    const f = next();
    await cardSegment(f, STUDIO_LIMITS.REFLECTION_CARD_SECONDS, [
      { file: await txt("reflection", wrapText(`「${input.reflection}」`, 13)), size: 46, y: "(h-text_h)/2-40" },
      { file: await txt("reflection_label", "— 你寫下的話"), size: 28, y: "h*0.66", color: "0xB4B0A6" },
    ]);
    segments.push(f);
  };

  for (const [i, shot] of sb.shots.entries()) {
    const m = input.media.find((x) => x.index === shot.media_index);
    if (!m) throw new Error("storyboard references unknown media");
    const cap = shot.caption ? await txt(`cap${i}`, wrapText(shot.caption, 13)) : null;
    const f = next();
    await shotSegment(f, m, path.join(workDir, "media", m.file), shot.seconds, shot.start_seconds, cap, input.tone);
    segments.push(f);
    if (sb.reflection_after_shot === i) await reflectionCard();
  }
  if (sb.reflection_after_shot === -1) await reflectionCard();

  const end = next();
  await cardSegment(end, STUDIO_LIMITS.END_CARD_SECONDS, [
    { file: await txt("ending", wrapText(sb.ending_text, 12)), size: 50, y: "(h-text_h)/2-30" },
    { file: await txt("brand", "MEmory · 只使用你提供的照片與影片剪輯"), size: 24, y: "h*0.62", color: "0x7D7A73" },
  ]);
  segments.push(end);

  const list = path.join(segDir, "list.txt");
  await writeFile(list, segments.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  await ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", input.out]);
  const s = await stat(input.out);
  const { stdout } = await run(competitionConfig().ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input.out]);
  return { seconds: Math.round(Number(stdout.trim()) * 10) / 10, bytes: s.size };
}
