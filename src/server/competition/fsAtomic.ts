import "server-only";
import { rename, rm, writeFile } from "node:fs/promises";

/**
 * Write JSON via temp file + rename. On Windows the rename can fail with EPERM/EBUSY/EACCES while
 * another handle (a status poll, antivirus) has the target open — observed live 2026-11-27 — so
 * retry with backoff, then fall back to a direct write.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
  await writeFile(file, data);
  await rm(tmp, { force: true });
}
