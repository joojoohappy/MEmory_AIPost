import { NextResponse } from "next/server";
import { deleteJob, loadJob, publicJob } from "@/server/competition/store";
import { startJob } from "@/server/competition/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await loadJob(id);
  if (!job) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: noStore });
  // Resume a job interrupted by a server restart.
  if (["queued", "analyzing", "planning", "rendering"].includes(job.status) && Date.now() - Date.parse(job.updated_at) > 120_000) startJob(id);
  return NextResponse.json({ job: publicJob(job) }, { headers: noStore });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await deleteJob(id);
  return NextResponse.json({ ok: true }, { headers: noStore });
}
