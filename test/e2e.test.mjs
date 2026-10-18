import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startServer } from "../src/server.mjs";
import { startWorker } from "../src/worker.mjs";
import { runCapability } from "../src/analysis/capabilities.mjs";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The worker parks a long-poll inside the relay for up to 25s. Plain
 * request.close does not always fire for fetch clients that have already
 * received their response, so a parked poll would keep the test alive until
 * the node:test runner's own timeout. Abort the worker and give the relay a
 * moment to drop the socket before closing it.
 */
async function stopWorker(worker, controller, relay) {
  controller.abort();
  const timedOut = await Promise.race([
    worker.then(() => false),
    sleep(2000).then(() => true),
  ]);
  await relay.close();
  if (timedOut) await sleep(500);
}

async function withRelay(fn) {
  const dir = await mkdtemp(join(tmpdir(), "relaydesk-test-"));
  const relay = await startServer({ dataDir: dir, host: "127.0.0.1", port: 0, log: () => {} });
  try {
    await fn({ relay, dir, base: `http://127.0.0.1:${relay.port}` });
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const auth = (relay) => ({ authorization: `Bearer ${relay.pairingToken}`, "content-type": "application/json" });

test("unauthenticated API calls are rejected", async () => {
  await withRelay(async ({ base }) => {
    const state = await fetch(`${base}/api/state`);
    assert.equal(state.status, 401);
    const worker = await fetch(`${base}/worker/register`, { method: "POST", body: "{}" });
    assert.equal(worker.status, 401);
  });
});

test("pairing issues a session cookie that unlocks the API", async () => {
  await withRelay(async ({ relay, base }) => {
    const bad = await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ token: "nope" }) });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/pair`, {
      method: "POST",
      body: JSON.stringify({ token: relay.pairingToken }),
    });
    assert.equal(good.status, 200);
    const cookie = good.headers.get("set-cookie").split(";")[0];

    const state = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    const value = await state.json();
    assert.ok(Array.isArray(value.capabilities));
    assert.ok(value.capabilities.some((item) => item.name === "file.kind"));

    const noCookie = await fetch(`${base}/api/state`);
    assert.equal(noCookie.status, 401);
  });
});

test("path traversal on the static root is refused", async () => {
  await withRelay(async ({ base }) => {
    const response = await fetch(`${base}/../package.json`);
    assert.ok([403, 404].includes(response.status), `got ${response.status}`);
  });
});

test("queued job is dispatched to a worker and the result lands in the case", async () => {
  await withRelay(async ({ relay, base }) => {
    const controller = new AbortController();
    const worker = startWorker({
      relayUrl: base,
      token: relay.pairingToken,
      name: "test-worker",
      capabilities: ["file.hash"],
      pollMs: 50,
      idleMs: 100,
      log: () => {},
      signal: controller.signal,
    });

    const jobResponse = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: auth(relay),
      body: JSON.stringify({
        capability: "file.hash",
        input: { path: fileURLToPath(new URL("../package.json", import.meta.url)) },
        title: "hash me",
      }),
    });
    assert.equal(jobResponse.status, 201);
    const { job } = await jobResponse.json();

    let latest = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await sleep(50);
      const read = await fetch(`${base}/api/jobs/${job.id}`, { headers: auth(relay) });
      const value = await read.json();
      latest = value.job;
      if (latest.status === "done" || latest.status === "failed") break;
    }
    // Read the audit trail before teardown, then stop the worker.
    const state = await (await fetch(`${base}/api/state`, { headers: auth(relay) })).json();
    const entries = state.entries.filter((entry) => entry.caseId === job.caseId);
    await stopWorker(worker, controller, relay);

    assert.equal(latest.status, "done", JSON.stringify(latest));
    assert.match(latest.result.facts.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entries.some((entry) => entry.kind === "request"));
    assert.ok(entries.some((entry) => entry.kind === "result"));
  });
});

test("unsupported capability input is rejected before dispatch", async () => {
  await withRelay(async ({ relay, base }) => {
    const response = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: auth(relay),
      body: JSON.stringify({ capability: "Not A Capability", input: {} }),
    });
    assert.equal(response.status, 400);
  });
});

test("local capability run reports evidence", async () => {
  const file = await mkdtemp(join(tmpdir(), "relaydesk-cap-"));
  const sample = join(file, "sample.bin");
  try {
    const payload = "hello relaydesk\n";
    await writeFile(sample, payload);
    const result = await runCapability("file.hash", { path: sample });
    assert.equal(result.facts.size, Buffer.byteLength(payload));
    assert.equal(result.capability, "file.hash");
  } finally {
    await rm(file, { recursive: true, force: true });
  }
});

test("mcp stdio answers initialize and tools/list", async () => {
  const child = spawn(process.execPath, ["bin/relaydesk.mjs", "mcp"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (const line of buffer.split("\n").slice(0, -1)) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
    buffer = buffer.split("\n").pop();
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  for (let attempt = 0; attempt < 100 && messages.length < 2; attempt += 1) await sleep(50);
  child.kill();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].result.serverInfo.name, "relaydesk");
  assert.ok(messages[1].result.tools.some((tool) => tool.name === "file_hash"));
});
