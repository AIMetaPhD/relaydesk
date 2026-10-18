#!/usr/bin/env node
import { networkInterfaces, homedir, hostname } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "../src/server.mjs";
import { startWorker } from "../src/worker.mjs";
import { runMcpStdio } from "../src/mcp.mjs";
import { CAPABILITIES, capabilityList } from "../src/analysis/capabilities.mjs";
import { parseDuration } from "../src/util.mjs";

const HELP = `relaydesk — a platform-neutral case file for agents, phones and analysis workers.

Usage:
  relaydesk serve   [--host 0.0.0.0] [--port 7331] [--data DIR]
  relaydesk worker  --relay URL --token TOKEN [--caps a,b] [--name NAME]
  relaydesk mcp     [--relay URL] [--token TOKEN]
  relaydesk demo    [--port 7331]

Environment:
  RELAYDESK_DATA        data directory (default ~/.relaydesk)
  RELAYDESK_RELAY_URL   relay base URL for worker/mcp
  RELAYDESK_TOKEN       pairing token for worker/mcp

Security:
  Prefer RELAYDESK_TOKEN over --token. A command-line argument is readable by
  every local process (Task Manager, tasklist, shell history). The token is a
  long-lived worker credential, not a one-time code.

Notes:
  - serve binds all interfaces so a phone on the same LAN can open it.
  - the pairing token is printed once and stored 0600 in the data directory.
  - worker makes outbound requests only; it needs no inbound port.
`;

function flags(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next == null || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        index += 1;
      }
    } else out._.push(token);
  }
  return out;
}

function dataDir(value) {
  return value || process.env.RELAYDESK_DATA || join(homedir(), ".relaydesk");
}

function lanAddresses(port) {
  const urls = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) urls.push(`http://${item.address}:${port}  (${name})`);
    }
  }
  return urls;
}

async function serve(options) {
  const host = options.host || "0.0.0.0";
  const port = Number(options.port || 7331);
  const dir = dataDir(options.data);
  await mkdir(dir, { recursive: true });
  const relay = await startServer({ dataDir: dir, host, port });
  const lines = [
    "",
    "  relaydesk relay is up",
    "",
    `  data       ${dir}`,
    `  local      http://127.0.0.1:${relay.port}`,
    ...lanAddresses(relay.port).map((url) => `  lan        ${url}`),
    `  pairing    ${relay.pairingToken}${relay.freshToken ? "   (new)" : ""}`,
    "",
    "  open the URL on your phone, type the pairing token once.",
    "  run a worker:  RELAYDESK_TOKEN=<token> relaydesk worker --relay http://127.0.0.1:" + relay.port,
    "",
  ];
  console.log(lines.join("\n"));
  const shutdown = () => {
    void relay.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return relay;
}

async function worker(options) {
  const relayUrl = options.relay || process.env.RELAYDESK_RELAY_URL;
  const token = options.token || process.env.RELAYDESK_TOKEN;
  if (!relayUrl || !token) {
    console.error("worker needs --relay and --token (or RELAYDESK_RELAY_URL / RELAYDESK_TOKEN)");
    process.exit(2);
  }
  const caps = options.caps
    ? String(options.caps).split(",").map((item) => item.trim()).filter(Boolean)
    : Object.keys(CAPABILITIES);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await startWorker({
    relayUrl: String(relayUrl).replace(/\/$/, ""),
    token: String(token),
    name: options.name || `${hostname()}-${process.platform}`,
    capabilities: caps,
    pollMs: parseDuration(options["poll-ms"], 0),
    idleMs: parseDuration(options["idle-ms"], 1000),
    log: (line) => console.log(line),
    signal: controller.signal,
  });
}

async function demo(options) {
  const port = Number(options.port || 7331);
  const dir = join(process.cwd(), ".relaydesk", "demo");
  await mkdir(dir, { recursive: true });
  const relay = await startServer({ dataDir: dir, host: "127.0.0.1", port });
  console.log(`\n  demo relay  http://127.0.0.1:${relay.port}`);
  console.log(`  pairing     ${relay.pairingToken}\n`);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const workerRun = startWorker({
    relayUrl: `http://127.0.0.1:${relay.port}`,
    token: relay.pairingToken,
    name: "demo-worker",
    capabilities: Object.keys(CAPABILITIES),
    pollMs: 300,
    idleMs: 1000,
    log: (line) => console.log("  worker>", line),
    signal: controller.signal,
  });
  console.log("  worker is polling for requests; open the URL and create a case.\n");
  await workerRun;
  await relay.close();
}

async function main() {
  const argv = process.argv.slice(2);
  const options = flags(argv);
  const command = options._[0] || "help";
  switch (command) {
    case "serve":
      await serve(options);
      break;
    case "worker":
      await worker(options);
      break;
    case "mcp":
      runMcpStdio();
      break;
    case "demo":
      await demo(options);
      break;
    case "capabilities":
      console.log(JSON.stringify(capabilityList(), null, 2));
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
