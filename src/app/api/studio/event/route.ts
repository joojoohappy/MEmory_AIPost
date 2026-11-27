import { NextResponse } from "next/server";
import { studioGate } from "@/contracts/competitionEvent";
import { competitionConfig } from "@/server/competition/config";
import { loadActiveEvent } from "@/server/competition/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const event = await loadActiveEvent();
  const cfg = competitionConfig();
  return NextResponse.json(
    {
      event,
      gate: studioGate(event, new Date()),
      ai: { configured: cfg.aiMode === "claude", vision_model: cfg.visionModel, story_model: cfg.storyModel },
      renderer: { name: "ffmpeg-local", font: Boolean(cfg.fontPath) },
      compdf: { configured: Boolean(cfg.compdfKey) },
      access: { code_required: Boolean(cfg.studioAccessCode) },
      public_repo_url: process.env.PUBLIC_REPO_URL?.startsWith("https://github.com/") ? process.env.PUBLIC_REPO_URL : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
