import { readFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLES_ROOT, SAMPLE_SETS } from "@/server/competition/intake";

export const runtime = "nodejs";

/** Serves the synthetic sample images (only these files) for the sample picker preview. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const set = u.searchParams.get("set") ?? "";
  const name = u.searchParams.get("name") ?? "";
  if (!(SAMPLE_SETS as readonly string[]).includes(set) || !/^[0-9a-z-]+\.(jpg|mp4)$/.test(name)) return new Response("nf", { status: 404 });
  try {
    const buf = await readFile(path.join(SAMPLES_ROOT, set, name));
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": name.endsWith(".mp4") ? "video/mp4" : "image/jpeg", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return new Response("nf", { status: 404 });
  }
}
