import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

const DEFAULT_TIMEOUT = 20000;
const MAX_OUTPUT = 200000;

/**
 * Windows console tools answer in the active OEM code page (GBK on a Chinese
 * install), not UTF-8. Decode UTF-8 first and fall back to the locale code page
 * so the stored evidence is not mojibake.
 */
function decode(buffer) {
  if (process.platform !== "win32") return buffer.toString("utf8");
  try {
    const strict = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (!strict.includes("�")) return strict;
  } catch {
    // Not valid UTF-8: a legacy console tool answered in the OEM code page.
  }
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function run(command, args, { timeout = DEFAULT_TIMEOUT, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: false });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: "", stderr: String(error.message), missing: true });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: null, stdout, stderr: stderr + "\n[timed out]", timedOut: true });
    }, timeout);
    child.stdout?.on("data", (chunk) => {
      outChunks.push(chunk);
      if (outChunks.reduce((sum, item) => sum + item.length, 0) > MAX_OUTPUT) child.kill("SIGKILL");
    });
    child.stderr?.on("data", (chunk) => {
      errChunks.push(chunk);
    });
    child.on("error", (error) => {
      finish({ ok: false, code: null, stdout, stderr: String(error.message), missing: error.code === "ENOENT" });
    });
    child.on("close", (code) => {
      stdout = decode(Buffer.concat(outChunks));
      stderr = decode(Buffer.concat(errChunks));
      finish({ ok: code === 0, code, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
  });
}

async function digestFile(path) {
  const buffer = await readFile(path);
  return { sha256: createHash("sha256").update(buffer).digest("hex"), size: buffer.length };
}

async function kindOf(_ctx, { path }) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  const digest = await digestFile(path);
  return {
    summary: `inspected ${basename(path)}`,
    facts: {
      path,
      name: basename(path),
      extension: extname(path).toLowerCase(),
      size: digest.size,
      sha256: digest.sha256,
      modified: info.mtime.toISOString(),
    },
  };
}

async function hash(_ctx, { path }) {
  const digest = await digestFile(path);
  return { summary: `sha256 ${digest.sha256.slice(0, 16)}`, facts: digest };
}

function whichResult(result, name) {
  return {
    name,
    available: result.ok,
    path: result.ok ? result.stdout.trim().split(/\r?\n/)[0] : null,
    error: result.ok ? null : (result.stderr || "").trim().slice(0, 400) || null,
  };
}

async function probe(_ctx, { tools = ["objdump", "readelf", "file", "strings", "jadx", "ghidra"] } = {}) {
  const results = [];
  for (const tool of tools) {
    const locator = process.platform === "win32" ? "where" : "which";
    results.push(whichResult(await run(locator, [tool]), tool));
  }
  return {
    summary: `${results.filter((item) => item.available).length}/${results.length} tools available`,
    facts: { platform: process.platform, arch: process.arch, tools: results },
  };
}

/**
 * A deliberately small analysis surface. Each capability is a plain function
 * so the registry stays legible and the worker can report exactly what it
 * supports instead of pretending to be a full decompiler.
 */
export const CAPABILITIES = {
  "file.kind": {
    description: "Size, SHA-256, extension and timestamps for one local file.",
    input: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    handler: kindOf,
  },
  "file.hash": {
    description: "SHA-256 and byte count for one local file.",
    input: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    handler: hash,
  },
  "tool.probe": {
    description: "Report which analysis tools exist on this worker.",
    input: { type: "object", required: [], properties: { tools: { type: "array", items: { type: "string" } } } },
    handler: probe,
  },
  "binary.strings": {
    description: "Extract printable strings from a local binary.",
    input: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        minLength: { type: "number", minimum: 4, maximum: 64 },
        limit: { type: "number", minimum: 1, maximum: 2000 },
      },
    },
    handler: async (_ctx, { path, minLength = 6, limit = 200 }) => {
      const result = await run("strings", [`-n`, String(minLength), path]);
      if (!result.ok) {
        throw new Error(result.missing ? "strings is not installed" : result.stderr.trim() || "strings failed");
      }
      const lines = result.stdout.split(/\r?\n/).filter(Boolean);
      const unique = [...new Set(lines)].slice(0, limit);
      return {
        summary: `${lines.length} strings, ${unique.length} unique shown`,
        facts: { count: lines.length, total: unique.length, sample: unique },
      };
    },
  },
  "binary.objdump": {
    description: "Cross-platform section/header summary through GNU objdump.",
    input: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        section: { type: "string", default: "headers" },
        limit: { type: "number", minimum: 1, maximum: 4000 },
      },
    },
    handler: async (_ctx, { path, section = "headers", limit = 120 }) => {
      const flag = section === "disassemble" ? "-d" : `-${String(section).replace(/[^a-z-]/g, "") || "headers"}`;
      const result = await run("objdump", [flag, path]);
      if (!result.ok) {
        throw new Error(result.missing ? "objdump is not installed" : result.stderr.trim() || "objdump failed");
      }
      const lines = result.stdout.split(/\r?\n/);
      return {
        summary: `objdump ${flag} -> ${lines.length} lines`,
        facts: { flag, line_count: lines.length, lines: lines.slice(0, limit) },
      };
    },
  },
};

export function capabilityList() {
  return Object.entries(CAPABILITIES).map(([name, spec]) => ({
    name,
    description: spec.description,
    input: spec.input,
  }));
}

export async function runCapability(name, input, ctx = {}) {
  const spec = CAPABILITIES[name];
  if (!spec) throw new Error(`unsupported capability: ${name}`);
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  for (const field of spec.input.required || []) {
    if (input[field] == null) throw new Error(`missing input: ${field}`);
  }
  // Unknown keys usually mean a typo in a path or tool name; reject them
  // instead of silently running with defaults.
  const allowed = new Set(Object.keys(spec.input.properties || {}));
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unknown input: ${unknown.join(", ")}`);
  const started = Date.now();
  const value = await spec.handler(ctx, input);
  return {
    capability: name,
    summary: value.summary,
    facts: value.facts,
    duration_ms: Date.now() - started,
    worker: { platform: process.platform, arch: process.arch, node: process.version },
  };
}
