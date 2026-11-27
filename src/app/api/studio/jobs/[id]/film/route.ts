import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { filmPath, loadJob } from "@/server/competition/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams the rendered film (supports Range for the <video> player). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await loadJob(id);
  if (!job || job.status !== "done") return new Response("not found", { status: 404 });
  const download = new URL(req.url).searchParams.get("download") === "1";
  if (download && !job.download_allowed) return new Response("download not permitted for this event", { status: 403 });
  const file = filmPath(id);
  const size = (await stat(file)).size;
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (download) headers["Content-Disposition"] = `attachment; filename="memory-${id.slice(0, 8)}.mp4"`;
  const range = req.headers.get("range");
  const m = range?.match(/bytes=(\d*)-(\d*)/);
  if (m && !download) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
}
