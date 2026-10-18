import { createInterface } from "node:readline";
import { VERSION } from "./version.mjs";
import { capabilityList } from "./analysis/capabilities.mjs";

/**
 * Minimal MCP stdio server (newline-delimited JSON-RPC 2.0). Implemented here
 * rather than pulled from a dependency so the demo stays zero-install and runs
 * identically on Windows, macOS, Linux and ARM.
 */
const PROTOCOL_VERSION = "2024-11-05";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function relayFetch({ relayUrl, token }, path, { method = "GET", body } = {}) {
  const response = await fetch(relayUrl + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(value?.error || `relay HTTP ${response.status}`);
  return value;
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolsFor(config) {
  const bridgeTools = [];
  if (config.relayUrl && config.token) {
    bridgeTools.push(
      {
        name: "relaydesk_create_case",
        description: "Create a case file that groups requests, evidence and worker results.",
        inputSchema: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            capability: { type: "string", description: "Capability this case expects, e.g. binary.strings" },
          },
        },
      },
      {
        name: "relaydesk_request",
        description:
          "Queue an analysis request for a connected worker. Returns a job id; poll with relaydesk_job.",
        inputSchema: {
          type: "object",
          required: ["capability"],
          properties: {
            capability: { type: "string" },
            input: { type: "object", description: "Capability-specific input, e.g. {\"path\":\"...\"}" },
            caseId: { type: "string" },
            title: { type: "string" },
          },
        },
      },
      {
        name: "relaydesk_job",
        description: "Read one job and its case entries.",
        inputSchema: {
          type: "object",
          required: ["jobId"],
          properties: { jobId: { type: "string" } },
        },
      },
      {
        name: "relaydesk_workers",
        description: "List workers that recently polled the relay and what they can run.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "relaydesk_state",
        description: "Current cases, recent entries and job status counts.",
        inputSchema: { type: "object", properties: {} },
      },
    );
  }
  return bridgeTools;
}

export function createMcpServer(config = {}) {
  const localTools = capabilityList().map((item) => ({
    name: item.name.replace(/\./g, "_"),
    description: `Run locally: ${item.description}`,
    inputSchema: item.input,
  }));
  const tools = [...localTools, ...toolsFor(config)];

  const handlers = {
    initialize: (params) => ({
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "relaydesk", version: VERSION },
    }),
    "notifications/initialized": () => undefined,
    "ping": () => ({}),
    "tools/list": () => ({ tools }),
    "resources/list": () => ({ resources: [] }),
    "prompts/list": () => ({ prompts: [] }),
    "tools/call": async (params) => {
      const name = params?.name;
      const args = params?.arguments || {};
      const local = capabilityList().find((item) => item.name.replace(/\./g, "_") === name);
      if (local) {
        const { runCapability } = await import("./analysis/capabilities.mjs");
        const value = await runCapability(local.name, args, {});
        return textResult(value);
      }
      switch (name) {
        case "relaydesk_create_case":
          return textResult(
            await relayFetch(config, "/api/cases", { method: "POST", body: args }),
          );
        case "relaydesk_request":
          return textResult(await relayFetch(config, "/api/jobs", { method: "POST", body: args }));
        case "relaydesk_job":
          return textResult(await relayFetch(config, `/api/jobs/${encodeURIComponent(args.jobId)}`));
        case "relaydesk_workers":
          return textResult(await relayFetch(config, "/api/workers"));
        case "relaydesk_state":
          return textResult(await relayFetch(config, "/api/state"));
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    },
  };

  async function handle(message) {
    if (message.id == null) {
      await handlers[message.method]?.(message.params);
      return;
    }
    try {
      const handler = handlers[message.method];
      if (!handler) throw new Error(`method not found: ${message.method}`);
      const result = await handler(message.params);
      send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } });
    }
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    void handle(message);
  });
}

export function runMcpStdio() {
  createMcpServer({
    relayUrl: process.env.RELAYDESK_RELAY_URL || null,
    token: process.env.RELAYDESK_TOKEN || null,
  });
}
