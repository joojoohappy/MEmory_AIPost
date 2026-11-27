import { NextResponse } from "next/server";
import { IntakeError, SAMPLE_SETS, createStudioJob, formFiles, sampleFiles, type SampleSet } from "@/server/competition/intake";
import { startJob } from "@/server/competition/pipeline";
import { studioAccess } from "@/server/competition/organizerAuth";
import { publicJob } from "@/server/competition/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const noStore = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const clientKey = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "direct").trim();
  const access = studioAccess(req, clientKey);
  if (access === "required") return NextResponse.json({ error: { code: "ACCESS_CODE_REQUIRED" } }, { status: 401, headers: noStore });
  if (access === "locked") return NextResponse.json({ error: { code: "ACCESS_CODE_LOCKED" } }, { status: 429, headers: noStore });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: { code: "BAD_REQUEST" } }, { status: 400, headers: noStore });
  }
  const sample = String(form.get("sample") ?? "");
  const sampleSet = (SAMPLE_SETS as readonly string[]).includes(sample) ? (sample as SampleSet) : null;
  try {
    const files = sampleSet
      ? await sampleFiles(sampleSet)
      : formFiles(form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f));
    const job = await createStudioJob({
      files,
      reflection: String(form.get("reflection") ?? ""),
      tone: String(form.get("tone") ?? ""),
      consent: form.get("consent") === "1",
      sampleSet,
      clientKey,
    });
    startJob(job.id);
    return NextResponse.json({ job: publicJob(job) }, { status: 202, headers: noStore });
  } catch (err) {
    if (err instanceof IntakeError) return NextResponse.json({ error: { code: err.code } }, { status: err.status, headers: noStore });
    console.error("[studio] intake failed", err instanceof Error ? err.message.slice(0, 200) : "unknown");
    return NextResponse.json({ error: { code: "INTERNAL" } }, { status: 500, headers: noStore });
  }
}
