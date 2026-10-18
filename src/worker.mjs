import { hostname } from "node:os";
import { VERSION } from "./version.mjs";
import { randomUUID } from "node:crypto";
import { runCapability } from "./analysis/capabilities.mjs";
import { parseDuration } from "./util.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(base, path, { method = "GET", token, body, timeoutMs = 15000, signal = null } = {}) {
  // Combine the caller's stop signal with a per-request timeout. Without this
  // a parked long-poll keeps the worker alive for its full timeout even after
  // the operator pressed Ctrl-C.
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: combined,
  }).then(async (response) => {
    if (response.status === 204) return { ok: true, status: 204, value: null };
    const text = await response.text();
    let value = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = { raw: text };
    }
    return { ok: response.ok, status: response.status, value };
  });
}

/**
 * Worker: outbound-only HTTP polling. It needs no inbound port, no Tailscale
 * node and no native binary, which is exactly what the phone/ARM/locked-down
 * hosts of Yobiru's receiver model could not satisfy.
 */
export async function startWorker({
  relayUrl,
  token,
  name = `${hostname()}-${process.platform}`,
  capabilities,
  pollMs = 1000,
  idleMs = 30000,
  log = console.log,
  signal = null,
}) {
  const workerId = randomUUID();
  const caps = capabilities || Object.values({});
  let advertised = caps;
  let stopping = false;

  const stop = () => {
    stopping = true;
  };
  signal?.addEventListener?.("abort", stop);

  // Registration retries instead of exiting: a worker started at boot often
  // finds the relay not yet listening, and exiting there means nobody notices
  // until someone checks by hand. A 401 is the one unrecoverable answer.
  let response = null;
  let registerBackoff = 1000;
  while (!stopping) {
    try {
      response = await request(relayUrl, "/worker/register", {
        method: "POST",
        token,
        signal: signal || null,
        body: {
          workerId,
          name,
          capabilities: advertised,
          platform: `${process.platform}/${process.arch}`,
          version: VERSION,
        },
      });
      if (response.status === 401) throw new Error("relay rejected the pairing token");
      if (response.ok) break;
      log(JSON.stringify({ event: "worker.register_failed", status: response.status, retry_in_ms: registerBackoff }));
    } catch (error) {
      if (/pairing token/.test(error.message)) throw error;
      log(JSON.stringify({ event: "worker.register_failed", message: error.message, retry_in_ms: registerBackoff }));
    }
    await sleep(registerBackoff + Math.floor(Math.random() * 250));
    registerBackoff = Math.min(registerBackoff * 2, 30000);
  }
  if (!response?.ok) {
    log(JSON.stringify({ event: "worker.stopped", workerId, reason: "stopped before registering" }));
    return { workerId };
  }
  log(JSON.stringify({ event: "worker.registered", workerId, relayUrl, capabilities: advertised.length }));
  if (Array.isArray(response.value?.worker?.capabilities)) {
    advertised = response.value.worker.capabilities;
  }

  let lastBeat = Date.now();
  let backoff = 0;

  while (!stopping) {
    try {
      if (Date.now() - lastBeat > 15000) {
        lastBeat = Date.now();
        await request(relayUrl, "/worker/heartbeat", {
          method: "POST",
          token,
          signal: signal || null,
          body: { workerId, name, capabilities: advertised, platform: `${process.platform}/${process.arch}` },
        });
      }

      const poll = await request(relayUrl, "/worker/poll", {
        method: "POST",
        token,
        signal: signal || null,
        timeoutMs: 40000,
        body: {
          workerId,
          name,
          capabilities: advertised,
          platform: `${process.platform}/${process.arch}`,
          waitMs: 25000,
        },
      });

      if (poll.status === 401) {
        // Nothing can recover from a rotated token without the operator, so
        // stop instead of hammering the relay with a known-bad credential.
        log(JSON.stringify({ event: "worker.fatal", message: "relay rejected the pairing token" }));
        stopping = true;
        break;
      }

      if (!poll.ok && poll.status !== 204) {
        await sleep(idleMs);
        continue;
      }
      if (!poll.value?.job) {
        // The relay already held this poll open for waitMs; do not add a
        // second idle wait on top of it.
        await sleep(Math.min(idleMs, 50));
        continue;
      }

      const job = poll.value.job;
      log(JSON.stringify({ event: "job.received", jobId: job.id, capability: job.capability }));
      let payload;
      try {
        const result = await runCapability(job.capability, job.input || {}, { workerId });
        payload = { jobId: job.id, ok: true, summary: result.summary, result };
      } catch (error) {
        payload = { jobId: job.id, ok: false, error: error.message, result: { error: error.message } };
      }
      const done = await request(relayUrl, "/worker/complete", { method: "POST", token, body: payload });
      log(JSON.stringify({ event: "job.completed", jobId: job.id, ok: payload.ok, relayOk: done.ok }));
    } catch (error) {
      // Exponential backoff with jitter. The old path used pollMs * 5, and
      // pollMs defaults to 0, so an unreachable relay was retried in a tight
      // loop. 401 is handled above and stops the worker instead.
      backoff = Math.min(backoff === 0 ? 1000 : backoff * 2, 30000);
      const wait = backoff + Math.floor(Math.random() * 250);
      log(JSON.stringify({ event: "worker.error", message: error.message, retry_in_ms: wait }));
      await sleep(wait);
      continue;
    }
    backoff = 0;
    await sleep(pollMs);
  }

  log(JSON.stringify({ event: "worker.stopped", workerId }));
  return { workerId };
}

export { parseDuration };
