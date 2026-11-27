import { NextResponse } from "next/server";
import { createDoc, processDoc } from "@/server/competition/organizer";
import { organizerAllowed } from "@/server/competition/organizerAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const noStore = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  if (!organizerAllowed(req)) return NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403, headers: noStore });
  const form = await req.formData().catch(() => null);
  const f = form?.get("file");
  if (!f || typeof f !== "object" || !("arrayBuffer" in f)) return NextResponse.json({ error: { code: "FILE_REQUIRED" } }, { status: 400, headers: noStore });
  const buf = Buffer.from(await (f as File).arrayBuffer());
  if (buf.length > 20_000_000) return NextResponse.json({ error: { code: "FILE_TOO_LARGE" } }, { status: 413, headers: noStore });
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return NextResponse.json({ error: { code: "NOT_PDF" } }, { status: 400, headers: noStore });
  const doc = await createDoc((f as File).name || "document.pdf", buf);
  void processDoc(doc.id);
  return NextResponse.json({ doc }, { status: 202, headers: noStore });
}
