import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export function id(prefix = "") {
  return (prefix ? prefix + "_" : "") + randomBytes(9).toString("base64url");
}

export function now() {
  return new Date().toISOString();
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... [truncated ${text.length - limit} chars]`;
}

export function parseDuration(value, fallbackMs) {
  if (value == null) return fallbackMs;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(String(value));
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2] || "ms";
  return amount * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
}
