import { NextResponse } from "next/server";
import { loadDoc } from "@/server/competition/organizer";
import { organizerAllowed } from "@/server/competition/organizerAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!organizerAllowed(req)) return NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  const doc = await loadDoc((await ctx.params).id);
  if (!doc) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  return NextResponse.json({ doc }, { headers: { "Cache-Control": "no-store" } });
}
