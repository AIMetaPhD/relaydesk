import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Auth } from "./auth.mjs";
import { Store } from "./store.mjs";
import { id } from "./util.mjs";
import { capabilityList } from "./analysis/capabilities.mjs";

const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));
const MAX_BODY = 1024 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = normalize(join(WEB_ROOT, requested));
  const guard = relative(WEB_ROOT, target);
  if (guard.startsWith("..") || isAbsolute(guard)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    throw error;
  }
}

export async function startServer({ dataDir, host = "0.0.0.0", port = 7331, log = console.log }) {
  const store = new Store(join(dataDir, "relaydesk.json"));
  await store.load();
  const auth = new Auth({ tokenPath: join(dataDir, "pairing-token") });
  const { token, created } = await auth.loadOrCreate();
  const logBuffer = [];
  const pushLog = (level, message) => {
    logBuffer.unshift({ at: new Date().toISOString(), level, message });
    logBuffer.length = Math.min(logBuffer.length, 200);
    store.emit({ type: "log", level, message });
  };

  const streams = new Set();
  // Workers long-poll instead of sleeping, so a request queued from a phone is
  // picked up immediately instead of waiting out a fixed idle interval.
  const waiters = new Set();
  const wakeWaiters = () => {
    for (const waiter of [...waiters]) {
      const job = store.queuedJob(null, waiter.capabilities);
      if (!job) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.deliver(job);
    }
  };
  store.subscribe((event) => {
    for (const res of streams) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    if (event.type === "job.created") setImmediate(wakeWaiters);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    try {
      if (pathname === "/healthz") {
        json(res, 200, { ok: true, uptime_s: Math.round(process.uptime()) });
        return;
      }

      if (pathname === "/pair" && req.method === "POST") {
        const body = await readBody(req);
        const session = auth.pair(body.token);
        if (!session) {
          json(res, 401, { ok: false, error: "invalid_or_expired_token" });
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `relaydesk_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
        });
        res.end(JSON.stringify({ ok: true }));
        pushLog("info", "device paired");
        return;
      }

      if (pathname.startsWith("/api/")) {
        const mode = auth.authenticateHeaders(req.headers);
        if (!mode) {
          json(res, 401, { ok: false, error: "unauthorized" });
          return;
        }

        if (pathname === "/api/state" && req.method === "GET") {
          json(res, 200, {
            ok: true,
            cases: store.state.cases,
            entries: store.state.entries.slice(0, 500),
            jobs: store.state.jobs.slice(0, 200),
            workers: store.state.workers,
            stats: store.stats(),
            logs: logBuffer,
            servers: [{ addr: url.host }],
            capabilities: capabilityList(),
          });
          return;
        }

        if (pathname === "/api/notes" && req.method === "POST") {
          const body = await readBody(req);
          const parent = store.getCase(String(body.caseId || ""));
          if (!parent) {
            json(res, 404, { ok: false, error: "unknown_case" });
            return;
          }
          const text = String(body.text || "").trim();
          if (!text) {
            json(res, 400, { ok: false, error: "empty_note" });
            return;
          }
          const entry = store.addEntry({ caseId: parent.id, kind: "note", text, source: "browser" });
          json(res, 201, { ok: true, entry });
          return;
        }

        if (pathname === "/api/events" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(`retry: 3000\n\n`);
          streams.add(res);
          const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
          req.on("close", () => {
            clearInterval(keepAlive);
            streams.delete(res);
          });
          return;
        }

        if (pathname === "/api/cases" && req.method === "POST") {
          const body = await readBody(req);
          const record = store.createCase({
            title: body.title,
            tags: body.tags,
            capability: body.capability,
          });
          pushLog("info", `case created: ${record.title}`);
          json(res, 201, { ok: true, case: record });
          return;
        }

        // Job ids are base64url (id() in util.mjs), so "-" is a valid character.
        const jobMatch = /^\/api\/jobs\/([A-Za-z0-9_-]+)$/.exec(pathname);
        if (jobMatch && req.method === "GET") {
          const job = store.getJob(jobMatch[1]);
          if (!job) {
            json(res, 404, { ok: false, error: "not_found" });
            return;
          }
          json(res, 200, { ok: true, job, entries: store.entriesFor(job.caseId) });
          return;
        }

        if (pathname === "/api/jobs" && req.method === "POST") {
          const body = await readBody(req);
          const capability = String(body.capability || "");
          if (!capability || !/^[a-z][a-z0-9_.:-]{0,79}$/.test(capability)) {
            json(res, 400, { ok: false, error: "invalid_capability" });
            return;
          }
          let caseRecord = body.caseId ? store.getCase(body.caseId) : null;
          if (!caseRecord) {
            caseRecord = store.createCase({
              title: body.title || `${capability} · ${new Date().toLocaleString()}`,
              capability,
            });
          }
          const job = store.addJob({
            caseId: caseRecord.id,
            capability,
            input: body.input && typeof body.input === "object" ? body.input : {},
            title: body.title || "",
          });
          // The phone is a client, not a worker: every browser job lands in the
          // audit trail immediately so the evidence survives the request.
          store.addEntry({
            caseId: caseRecord.id,
            kind: "request",
            text: `requested ${capability}`,
            data: { jobId: job.id, input: job.input },
            source: "browser",
          });
          pushLog("info", `job queued: ${capability}`);
          json(res, 201, { ok: true, job, case: caseRecord });
          return;
        }

        if (pathname === "/api/workers" && req.method === "GET") {
          json(res, 200, { ok: true, workers: store.liveWorkers(90000) });
          return;
        }

        json(res, 404, { ok: false, error: "not_found" });
        return;
      }

      if (pathname.startsWith("/worker/")) {
        const mode = auth.authenticateHeaders(req.headers);
        if (!mode) {
          json(res, 401, { ok: false, error: "unauthorized" });
          return;
        }

        if (pathname === "/worker/register" && req.method === "POST") {
          const body = await readBody(req);
          const worker = store.registerWorker({
            workerId: body.workerId || id("worker"),
            name: body.name,
            capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
            platform: `${process.platform} relay / ${body.platform || "unknown"}`,
            version: body.version,
          });
          pushLog("info", `worker online: ${worker.name}`);
          json(res, 200, { ok: true, worker });
          return;
        }

        if (pathname === "/worker/heartbeat" && req.method === "POST") {
          const body = await readBody(req);
          const worker = store.registerWorker({
            workerId: body.workerId,
            name: body.name,
            capabilities: body.capabilities || [],
            platform: body.platform,
            version: body.version,
          });
          json(res, 200, { ok: true, worker });
          return;
        }

        if (pathname === "/worker/poll" && req.method === "POST") {
          const body = await readBody(req);
          store.registerWorker({
            workerId: body.workerId,
            name: body.name,
            capabilities: body.capabilities || [],
            platform: body.platform,
            version: body.version,
          });
          const capabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
          const job = store.queuedJob(null, capabilities);
          if (job) {
            store.updateJob(job.id, { status: "running", workerId: body.workerId });
            pushLog("info", `worker ${body.name || body.workerId} took ${job.capability}`);
            json(res, 200, { ok: true, job });
            return;
          }
          const waitMs = Math.min(Math.max(Number(body.waitMs) || 15000, 1000), 30000);
          const waiter = {
            capabilities,
            timer: null,
            deliver: (picked) => {
              store.updateJob(picked.id, { status: "running", workerId: body.workerId });
              pushLog("info", `worker ${body.name || body.workerId} took ${picked.capability}`);
              json(res, 200, { ok: true, job: picked });
            },
          };
          waiter.timer = setTimeout(() => {
            waiters.delete(waiter);
            json(res, 204, { ok: true });
          }, waitMs);
          waiters.add(waiter);
          req.on("close", () => {
            clearTimeout(waiter.timer);
            waiters.delete(waiter);
          });
          return;
        }

        if (pathname === "/worker/complete" && req.method === "POST") {
          const body = await readBody(req);
          const job = store.getJob(body.jobId);
          if (!job) {
            json(res, 404, { ok: false, error: "unknown_job" });
            return;
          }
          store.updateJob(job.id, {
            status: body.ok === false ? "failed" : "done",
            result: body.result ?? null,
            error: body.error ?? null,
          });
          store.addEntry({
            caseId: job.caseId,
            kind: "result",
            text: body.summary || `${job.capability} ${body.ok === false ? "failed" : "finished"}`,
            data: body.result ?? { error: body.error },
            source: `worker:${body.workerId || job.workerId}`,
          });
          pushLog("info", `worker finished ${job.capability}`);
          json(res, 200, { ok: true, job });
          return;
        }

        json(res, 404, { ok: false, error: "not_found" });
        return;
      }

      if (pathname === "/api" || pathname === "/api/") {
        json(res, 200, { ok: true, service: "relaydesk", version: "0.1.0" });
        return;
      }

      await serveStatic(res, pathname);
    } catch (error) {
      pushLog("error", error.message);
      if (!res.headersSent) json(res, 500, { ok: false, error: error.message });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  let closing = null;
  const result = {
    server,
    store,
    auth,
    port: address.port,
    host,
    pairingToken: token,
    freshToken: created,
    close: () => {
      if (!closing) {
        closing = new Promise((resolve) => server.close(() => resolve()));
        // Long-poll waiters keep sockets open; release them so close() finishes.
        for (const waiter of [...waiters]) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
        }
      }
      return closing;
    },
  };
  log(JSON.stringify({ event: "listening", host, port: address.port }));
  return result;
}
