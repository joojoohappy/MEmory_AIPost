import "server-only";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { activeEventSchema, type ActiveEvent } from "@/contracts/competitionEvent";
import { competitionConfig } from "./config";
import { writeJsonAtomic } from "./fsAtomic";

/**
 * Built-in seed used until an organizer imports a document-derived configuration. It is
 * labelled source="seed" in the UI. Its permissions are the product's own defaults for a
 * user's personal media (photos/videos for their own film, personal download); everything
 * that would need an organizer's grant stays disabled.
 */
export const SEED_EVENT: ActiveEvent = {
  id: "memory-demo-seed",
  name: "MEmory 現場記憶示範",
  start_date: null,
  end_date: null,
  venue: null,
  organizer: null,
  description: "用你在活動現場拍下的照片與影片，加上一句你自己的話，剪成一支屬於你的記憶短片。",
  schedule: [],
  generation_valid_from: null,
  generation_valid_until: null,
  permissions: {
    attendee_photos: true,
    attendee_videos: true,
    personal_download: true,
    public_sharing: false,
    commercial_use: false,
    official_assets: false,
  },
  source: "seed",
  source_document: null,
  confirmed_at: null,
  confirmed_by_note: null,
  activation: "active",
};

function activeFile(): string {
  return path.join(competitionConfig().dataDir, "event", "active.json");
}

export async function loadActiveEvent(): Promise<ActiveEvent> {
  try {
    const raw = JSON.parse(await readFile(activeFile(), "utf8"));
    const parsed = activeEventSchema.safeParse(raw);
    return parsed.success ? parsed.data : SEED_EVENT;
  } catch {
    return SEED_EVENT;
  }
}

export async function saveActiveEvent(ev: ActiveEvent): Promise<void> {
  const file = activeFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, activeEventSchema.parse(ev));
}

export async function resetActiveEvent(): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(activeFile(), { force: true });
}
