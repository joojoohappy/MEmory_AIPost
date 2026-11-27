import { NextResponse } from "next/server";
import { z } from "zod";
import { RIGHT_KEYS } from "@/contracts/competitionEvent";
import { confirmDoc } from "@/server/competition/organizer";
import { organizerAllowed } from "@/server/competition/organizerAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  rights: z.object(Object.fromEntries(RIGHT_KEYS.map((k) => [k, z.boolean().optional()]))).partial(),
  overrides: z.record(z.string(), z.string().max(400)).default({}),
  acknowledge_unsigned: z.boolean().default(false),
  reviewer_note: z.string().max(300).default(""),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!organizerAllowed(req)) return NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "BAD_REQUEST" } }, { status: 400 });
  try {
    const ev = await confirmDoc((await ctx.params).id, parsed.data as Parameters<typeof confirmDoc>[1]);
    return NextResponse.json({ event: ev }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: { code: err instanceof Error ? err.message : "INTERNAL" } }, { status: 400 });
  }
}
