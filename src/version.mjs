import { readFileSync } from "node:fs";

// Single source of truth: package.json. Kept in one place so the MCP server
// info, the HTTP banner and worker registration cannot drift apart.
export const VERSION = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return JSON.parse(raw).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
