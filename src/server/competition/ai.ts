import "server-only";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ANALYSIS_JSON_SCHEMA,
  STORYBOARD_JSON_SCHEMA,
  TONE_LABELS,
  analysisResultSchema,
  validateStoryboard,
  type MediaAnalysis,
  type Storyboard,
  type StudioMediaInfo,
  type Tone,
} from "@/contracts/competition";
import type { ActiveEvent } from "@/contracts/competitionEvent";
import { structuredCall, type AiCallRecord } from "./claude";
import { competitionConfig } from "./config";
import { analysisStill, sampleTimes } from "./media";
import type { JobMedia } from "./store";

const ANALYSIS_SYSTEM = [
  "你是 MEmory 的素材理解助手。使用者在真實活動現場拍下照片與影片，你要幫他整理「畫面中確實看得到的內容」。",
  "規則：",
  "1. 只描述看得到的東西（場景、物件、光線、動態），不要猜測地點名稱、人物身分、姓名、年齡、族群或情緒。",
  "2. 有人出現時只寫「有人」「觀眾」「舞台上的人」這類中性描述，不辨識身分。",
  "3. 看不清楚就說看不清楚，不要補完。",
  "4. 影片會提供數個影格與其秒數；best_start_seconds 只能從提供的秒數中選一個。照片一律填 null。",
  "5. 所有文字用繁體中文。index 要與輸入的素材編號一致，每個素材恰好一筆。",
].join("\n");

export async function analyzeMedia(
  media: JobMedia[],
  workDir: string,
): Promise<{ analysis: MediaAnalysis[] | null; calls: AiCallRecord[] }> {
  const cfg = competitionConfig();
  const content: Anthropic.ContentBlockParam[] = [];
  for (const m of media) {
    const file = path.join(workDir, "media", m.file);
    if (m.type === "photo") {
      const img = await analysisStill(file, workDir, `a${m.index}`, null);
      content.push({ type: "text", text: `素材 ${m.index}：照片` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") } });
    } else {
      const times = sampleTimes(m.durationSeconds ?? 0);
      content.push({ type: "text", text: `素材 ${m.index}：影片，長度 ${(m.durationSeconds ?? 0).toFixed(1)} 秒，以下為影格` });
      for (const t of times) {
        const img = await analysisStill(file, workDir, `a${m.index}_${t}`, t);
        content.push({ type: "text", text: `素材 ${m.index} 影格 @${t} 秒` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") } });
      }
    }
  }
  content.push({ type: "text", text: `請為以上 ${media.length} 個素材各輸出一筆觀察。` });

  const calls: AiCallRecord[] = [];
  for (const model of [cfg.visionModel, cfg.fallbackModel]) {
    const { data, record } = await structuredCall({
      step: "media_analysis",
      model,
      system: ANALYSIS_SYSTEM,
      content,
      schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
      effort: "low",
    });
    calls.push(record);
    const parsed = analysisResultSchema.safeParse(data);
    if (parsed.success) {
      const items = media.map((m) => parsed.data.items.find((x) => x.index === m.index));
      if (items.every(Boolean)) {
        // A video start must be one of the offered frame times; otherwise 0.
        const fixed = (items as MediaAnalysis[]).map((a) => {
          const m = media.find((x) => x.index === a.index)!;
          if (m.type === "photo") return { ...a, best_start_seconds: null };
          const offered = sampleTimes(m.durationSeconds ?? 0);
          return { ...a, best_start_seconds: offered.includes(a.best_start_seconds ?? -1) ? a.best_start_seconds : 0 };
        });
        return { analysis: fixed, calls };
      }
      record.outcome = "invalid_json";
    }
  }
  return { analysis: null, calls };
}

const STORY_SYSTEM = [
  "你是 MEmory 的記憶短片剪輯規劃助手。MEmory 幫人保存「自己真實經歷過」的活動記憶，AI 只能協助整理，不能替使用者編造記憶。",
  "你會收到：活動資訊、每個素材的畫面觀察（由前一步 AI 看圖產生）、使用者自己寫下的感受原文、使用者選的氛圍。",
  "請產生一份分鏡：",
  "- shots：每個素材恰好用一次，可以重新排序讓節奏更好；照片 2–6 秒，影片不超過其可用長度且最多 8 秒；影片 start_seconds 建議用畫面觀察中的 best_start_seconds。",
  "- caption：每個鏡頭最多 20 字的字幕。只能根據該素材的畫面觀察（grounding=visual）、使用者原文（grounding=reflection）或活動資訊（grounding=event）。沒有根據就填 null（grounding=none）。",
  "- 不可捏造畫面中沒有的人事物、姓名、對話或具體事件；不可替使用者宣告他沒寫出的感受；不要療癒式結論。",
  "- 活動資訊只能用來交代情境（例如活動名稱、地點）；活動有多天時，不要斷言使用者是哪一天、哪個時段在場。",
  "- 使用者原文會由系統以原文獨立卡片呈現，你不要改寫或引用全文；reflection_after_shot 決定那張卡片放在哪個鏡頭之後。",
  "- title、ending_text 各最多 24 字；narrative 最多 200 字，用第二人稱「你」，只寫畫面看得到的與使用者自己寫的。",
  "- 氛圍影響節奏：溫柔回望＝較長、較緩；熱烈明亮＝較短、較多變化；安靜留白＝較長、字幕較少。",
  "- 全部鏡頭秒數加上片頭 2.5 秒、原文卡 4 秒、片尾 2.5 秒，總長不得超過 45 秒。",
  "所有文字使用繁體中文，不含網址或 HTML。",
].join("\n");

export async function planStoryboard(input: {
  event: ActiveEvent;
  media: StudioMediaInfo[];
  analysis: MediaAnalysis[];
  reflection: string;
  tone: Tone;
}): Promise<{ storyboard: Storyboard | null; repairs: string[]; calls: AiCallRecord[] }> {
  const cfg = competitionConfig();
  const payload = {
    event: {
      name: input.event.name,
      date: input.event.start_date,
      venue: input.event.venue,
      description: input.event.description,
    },
    tone: TONE_LABELS[input.tone],
    user_reflection_original: input.reflection || null,
    media: input.media.map((m) => {
      const a = input.analysis.find((x) => x.index === m.index)!;
      return {
        index: m.index,
        type: m.type,
        usable_seconds: m.type === "video" ? Math.min(8, m.durationSeconds ?? 0) : null,
        duration_seconds: m.durationSeconds,
        observation: { scene: a.scene, elements: a.visible_elements, lighting: a.lighting, energy: a.energy, people_visible: a.people_visible },
        best_start_seconds: a.best_start_seconds,
      };
    }),
  };
  const calls: AiCallRecord[] = [];
  let lastRepairs: string[] = [];
  for (const model of [cfg.storyModel, cfg.fallbackModel]) {
    const { data, record } = await structuredCall({
      step: "storyboard",
      model,
      system: STORY_SYSTEM,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      schema: STORYBOARD_JSON_SCHEMA as unknown as Record<string, unknown>,
      effort: "medium",
    });
    calls.push(record);
    if (data) {
      const v = validateStoryboard(data, input.media, Boolean(input.reflection));
      if (v.ok) return { storyboard: v.storyboard, repairs: v.repaired, calls };
      record.outcome = "invalid_json";
      record.error = `validation:${v.reasons.join(",")}`.slice(0, 200);
      lastRepairs = v.reasons;
    }
  }
  return { storyboard: null, repairs: lastRepairs, calls };
}
