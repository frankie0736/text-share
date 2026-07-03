import type { Env } from "./types";

const SESSION_COOKIE = "paste_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const textEncoder = new TextEncoder();

function requireAuthConfig(env: Env): void {
  if (!env.SHARE_PASSWORD || !env.SESSION_SECRET) {
    throw new Error("Auth is not configured");
  }
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)),
  );
}

function parseCookie(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    cookies.set(rawName, rawValue.join("="));
  }
  return cookies;
}

export async function isValidPassword(
  password: string,
  env: Env,
): Promise<boolean> {
  requireAuthConfig(env);
  const left = await hmacHex(env.SESSION_SECRET, password);
  const right = await hmacHex(env.SESSION_SECRET, env.SHARE_PASSWORD);
  return timingSafeEqual(left, right);
}

export async function createSessionCookie(
  env: Env,
  nowMs = Date.now(),
): Promise<string> {
  requireAuthConfig(env);
  const expiresAt = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expiresAt);
  const signature = await hmacHex(env.SESSION_SECRET, payload);
  return [
    `${SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export async function verifySession(
  request: Request,
  env: Env,
  nowMs = Date.now(),
): Promise<boolean> {
  requireAuthConfig(env);
  const rawSession = parseCookie(request.headers.get("cookie")).get(
    SESSION_COOKIE,
  );
  if (!rawSession) return false;
  const [expiresAtRaw, signature] = rawSession.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || !signature) return false;
  if (expiresAt <= Math.floor(nowMs / 1000)) return false;
  const expected = await hmacHex(env.SESSION_SECRET, expiresAtRaw);
  return timingSafeEqual(signature, expected);
}
