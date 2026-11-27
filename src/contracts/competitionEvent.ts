import { z } from "zod";

/**
 * Event configuration + content-rights policy produced by the Organizer Document Agent
 * (competition Track C) or by the built-in seed. Rights are tri-state; anything that is not an
 * explicit, human-confirmed "allowed" is treated as disabled by `effectivePermissions()`.
 */

export const RIGHT_KEYS = [
  "attendee_photos",
  "attendee_videos",
  "personal_download",
  "public_sharing",
  "commercial_use",
  "official_assets",
] as const;
export type RightKey = (typeof RIGHT_KEYS)[number];

export const RIGHT_LABELS: Record<RightKey, string> = {
  attendee_photos: "參加者自行拍攝的照片可用於生成",
  attendee_videos: "參加者自行拍攝的影片可用於生成",
  personal_download: "參加者可下載個人記憶短片",
  public_sharing: "可公開分享生成的短片",
  commercial_use: "可作商業用途",
  official_assets: "可使用主辦方官方素材（Logo、官方影像、音樂）",
};

export const sourceRefSchema = z.object({
  page: z.number().int().min(1).nullable(),
  quote: z.string().max(400),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const rightSchema = z.object({
  status: z.enum(["allowed", "restricted", "unknown", "conflict"]),
  note: z.string().max(400),
  sources: z.array(sourceRefSchema).max(6),
});
export type Right = z.infer<typeof rightSchema>;

export const fieldSchema = z.object({
  value: z.string().max(400).nullable(),
  sources: z.array(sourceRefSchema).max(6),
});

export const issueSchema = z.object({
  kind: z.enum(["missing", "ambiguous", "conflict", "approval_pending"]),
  field: z.string().max(80),
  detail: z.string().max(600),
  sources: z.array(sourceRefSchema).max(6),
});
export type Issue = z.infer<typeof issueSchema>;

export const eventProposalSchema = z.object({
  event_name: fieldSchema,
  start_date: fieldSchema,
  end_date: fieldSchema,
  venue: fieldSchema,
  organizer: fieldSchema,
  description: fieldSchema,
  schedule: z.array(z.object({ time: z.string().max(80), item: z.string().max(200), sources: z.array(sourceRefSchema).max(4) })).max(20),
  generation_valid_from: fieldSchema,
  generation_valid_until: fieldSchema,
  agreement_status: z.enum(["signed", "unsigned", "draft", "unknown"]),
  rights: z.object(Object.fromEntries(RIGHT_KEYS.map((k) => [k, rightSchema])) as Record<RightKey, typeof rightSchema>),
  issues: z.array(issueSchema).max(30),
});
export type EventProposal = z.infer<typeof eventProposalSchema>;

/**
 * Compact schema sent to the model (structured outputs). The nested sources-array version
 * exceeded the API's grammar size limit (HTTP 400 "compiled grammar is too large", observed
 * 2026-11-27), so each item carries ONE source: `source_quote` + `source_page`.
 * `compactToProposal()` converts it to EventProposal.
 */
const fieldJson = {
  type: "object",
  additionalProperties: false,
  required: ["value", "source_quote", "source_page"],
  properties: {
    value: { type: "string", description: "找不到就空字串" },
    source_quote: { type: "string", description: "文件原文逐字短引文；沒有就空字串" },
    source_page: { type: "integer", description: "頁碼；不確定填 0" },
  },
};

const FIELD_KEYS = ["event_name", "start_date", "end_date", "venue", "organizer", "description", "generation_valid_from", "generation_valid_until"] as const;

export const EVENT_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "schedule", "agreement_status", "rights", "issues"],
  properties: {
    fields: {
      type: "object",
      additionalProperties: false,
      required: [...FIELD_KEYS],
      properties: Object.fromEntries(FIELD_KEYS.map((k) => [k, fieldJson])),
      description: "日期欄位一律 YYYY-MM-DD",
    },
    schedule: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["time", "item"], properties: { time: { type: "string" }, item: { type: "string" } } },
    },
    agreement_status: { type: "string", enum: ["signed", "unsigned", "draft", "unknown"] },
    rights: {
      type: "array",
      description: `每個權利項目恰好一筆：${RIGHT_KEYS.join(", ")}`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "status", "note", "source_quote", "source_page"],
        properties: {
          key: { type: "string", enum: [...RIGHT_KEYS] },
          status: { type: "string", enum: ["allowed", "restricted", "unknown", "conflict"] },
          note: { type: "string" },
          source_quote: { type: "string" },
          source_page: { type: "integer", description: "頁碼；不確定填 0" },
        },
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "field", "detail", "source_quote", "source_page"],
        properties: {
          kind: { type: "string", enum: ["missing", "ambiguous", "conflict", "approval_pending"] },
          field: { type: "string" },
          detail: { type: "string" },
          source_quote: { type: "string", description: "矛盾時可用「／」連接兩段原文" },
          source_page: { type: "integer", description: "頁碼；不確定填 0" },
        },
      },
    },
  },
} as const;

type Compact = {
  fields: Record<(typeof FIELD_KEYS)[number], { value: string | null; source_quote: string; source_page: number | null }>;
  schedule: { time: string; item: string }[];
  agreement_status: EventProposal["agreement_status"];
  rights: { key: string; status: Right["status"]; note: string; source_quote: string; source_page: number | null }[];
  issues: { kind: Issue["kind"]; field: string; detail: string; source_quote: string; source_page: number | null }[];
};

const src = (q: string | undefined, page: number | null | undefined): SourceRef[] =>
  q && q.trim() ? [{ page: typeof page === "number" && page >= 1 ? page : null, quote: q.trim().slice(0, 400) }] : [];

/** Convert the model's compact output; rights the model omitted become "unknown". Returns null if malformed. */
export function compactToProposal(data: unknown): EventProposal | null {
  try {
    const c = data as Compact;
    const field = (k: (typeof FIELD_KEYS)[number]) => ({ value: c.fields[k]?.value?.trim() || null, sources: src(c.fields[k]?.source_quote, c.fields[k]?.source_page) });
    const rights = Object.fromEntries(
      RIGHT_KEYS.map((k) => {
        const r = c.rights.find((x) => x.key === k);
        return [k, r ? { status: r.status, note: r.note.slice(0, 400), sources: src(r.source_quote, r.source_page) } : { status: "unknown", note: "AI 未回報此項目", sources: [] }];
      }),
    );
    const candidate = {
      ...Object.fromEntries(FIELD_KEYS.map((k) => [k, field(k)])),
      schedule: (c.schedule ?? []).slice(0, 20).map((s) => ({ time: s.time.slice(0, 80), item: s.item.slice(0, 200), sources: [] })),
      agreement_status: c.agreement_status,
      rights,
      issues: (c.issues ?? []).slice(0, 30).map((i) => ({ kind: i.kind, field: i.field.slice(0, 80), detail: i.detail.slice(0, 600), sources: src(i.source_quote, i.source_page) })),
    };
    const parsed = eventProposalSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The configuration the consumer studio reads. */
export const activeEventSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  venue: z.string().nullable(),
  organizer: z.string().nullable(),
  description: z.string().nullable(),
  schedule: z.array(z.object({ time: z.string(), item: z.string() })),
  generation_valid_from: z.string().nullable(),
  generation_valid_until: z.string().nullable(),
  /** Human-confirmed permission per right. Only `true` enables a capability. */
  permissions: z.object(Object.fromEntries(RIGHT_KEYS.map((k) => [k, z.boolean()])) as Record<RightKey, z.ZodBoolean>),
  source: z.enum(["seed", "document"]),
  source_document: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  confirmed_by_note: z.string().nullable(),
  activation: z.enum(["active", "pending_signature", "inactive"]),
});
export type ActiveEvent = z.infer<typeof activeEventSchema>;

/**
 * Turn a proposal + the organizer's explicit decisions into permissions. A right is enabled only
 * when the document says "allowed" AND the human ticked it. "unknown"/"conflict"/"restricted"
 * can never be enabled here, regardless of what the request body claims.
 */
export function effectivePermissions(proposal: EventProposal, confirmed: Partial<Record<RightKey, boolean>>): Record<RightKey, boolean> {
  return Object.fromEntries(
    RIGHT_KEYS.map((k) => [k, proposal.rights[k].status === "allowed" && confirmed[k] === true]),
  ) as Record<RightKey, boolean>;
}

/** Taipei calendar date (YYYY-MM-DD) for an instant. */
export function taipeiDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export type StudioGate =
  | { open: true; photos: boolean; videos: boolean; download: boolean }
  | { open: false; reason: "inactive" | "before_window" | "after_window" | "no_media_allowed" };

/** What the consumer studio may do right now under the active event's policy. */
export function studioGate(ev: ActiveEvent, now: Date): StudioGate {
  if (ev.activation !== "active") return { open: false, reason: "inactive" };
  const today = taipeiDate(now);
  if (ev.generation_valid_from && today < ev.generation_valid_from) return { open: false, reason: "before_window" };
  if (ev.generation_valid_until && today > ev.generation_valid_until) return { open: false, reason: "after_window" };
  const photos = ev.permissions.attendee_photos;
  const videos = ev.permissions.attendee_videos;
  if (!photos && !videos) return { open: false, reason: "no_media_allowed" };
  return { open: true, photos, videos, download: ev.permissions.personal_download };
}
