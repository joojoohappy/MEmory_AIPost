import "server-only";
import { timingSafeEqual } from "node:crypto";
import { competitionConfig } from "./config";

/** Organizer endpoints change the live event config; require the shared token when one is set. */
export function organizerAllowed(req: Request): boolean {
  const token = competitionConfig().organizerToken;
  if (!token) return process.env.NODE_ENV !== "production";
  const got = req.headers.get("x-organizer-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const failures = new Map<string, number[]>();
const FAIL_WINDOW_MS = 60 * 60 * 1000;
const FAIL_LIMIT = 10;

export type StudioAccess = "ok" | "required" | "locked";

/**
 * Live generation spends paid AI credit. When STUDIO_ACCESS_CODE is set, a job needs the code in
 * x-studio-access; repeated wrong codes from one client lock it out for an hour.
 */
export function studioAccess(req: Request, clientKey: string): StudioAccess {
  const code = competitionConfig().studioAccessCode;
  if (!code) return "ok";
  const now = Date.now();
  const recent = (failures.get(clientKey) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (recent.length >= FAIL_LIMIT) return "locked";
  const a = Buffer.from(req.headers.get("x-studio-access")?.trim() ?? "");
  const b = Buffer.from(code);
  if (a.length === b.length && timingSafeEqual(a, b)) return "ok";
  recent.push(now);
  failures.set(clientKey, recent);
  return "required";
}
