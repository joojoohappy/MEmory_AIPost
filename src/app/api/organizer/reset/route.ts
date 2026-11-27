import { NextResponse } from "next/server";
import { resetActiveEvent } from "@/server/competition/event";
import { organizerAllowed } from "@/server/competition/organizerAuth";

export const runtime = "nodejs";

/** Return the studio to the built-in seed configuration. */
export async function POST(req: Request) {
  if (!organizerAllowed(req)) return NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  await resetActiveEvent();
  return NextResponse.json({ ok: true });
}
