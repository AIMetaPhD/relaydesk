import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { safeEqual } from "./util.mjs";

/**
 * One-time pairing token + session cookie. The pairing token is printed once
 * on first start and stored 0600 next to the data file. It is meant to be typed
 * on a phone over the LAN, so it is short-lived and single-use: after pairing,
 * the browser holds a signed random session value.
 */
export class Auth {
  constructor({ tokenPath, ttlMs = 10 * 60 * 1000 }) {
    this.tokenPath = tokenPath;
    this.ttlMs = ttlMs;
    this.token = null;
    this.issuedAt = 0;
    this.sessions = new Map();
  }

  async loadOrCreate() {
    let raw = null;
    try {
      raw = (await readFile(this.tokenPath, "utf8")).trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (raw && /^[a-f0-9]{16}$/.test(raw)) {
      this.token = raw;
      this.issuedAt = Date.now();
      return { token: this.token, created: false };
    }
    this.token = randomBytes(8).toString("hex");
    this.issuedAt = Date.now();
    await mkdir(dirname(this.tokenPath), { recursive: true });
    await writeFile(this.tokenPath, this.token + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(this.tokenPath, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file is still inside the user profile.
    }
    return { token: this.token, created: true };
  }

  rotate() {
    this.token = randomBytes(8).toString("hex");
    this.issuedAt = Date.now();
    void writeFile(this.tokenPath, this.token + "\n", { encoding: "utf8", mode: 0o600 });
    return this.token;
  }

  pair(candidate) {
    if (!this.token) return null;
    if (Date.now() - this.issuedAt > this.ttlMs) return null;
    if (!safeEqual(String(candidate || ""), this.token)) return null;
    const session = randomBytes(24).toString("base64url");
    this.sessions.set(session, { createdAt: Date.now(), lastSeen: Date.now() });
    return session;
  }

  check(session) {
    const record = this.sessions.get(String(session || ""));
    if (!record) return false;
    record.lastSeen = Date.now();
    return true;
  }

  authenticateHeaders(headers) {
    const bearer = headers.authorization || "";
    const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
    if (token && safeEqual(token, this.token)) return "bearer";
    const cookie = headers.cookie || "";
    for (const part of cookie.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === "relaydesk_session" && this.check(decodeURIComponent(value || ""))) return "session";
    }
    return null;
  }
}
