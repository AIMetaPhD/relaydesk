# relaydesk

> one case file · any device · any worker

A small, platform-neutral evidence ledger for agent-driven debugging. Open a case
on your phone, point a worker at it from any computer, and every request, result
and note lands in the same file — without installing anything on the phone and
without making the phone part of a mesh network.

This is a **demo**. It is deliberately small and it is honest about that.

```
 phone / tablet / browser          any computer
 ┌──────────────────────┐          ┌────────────────────────┐
 │  relaydesk web UI     │          │  relaydesk worker       │
 │  open case, request  │  HTTPS   │  runs local tools      │
 │  read evidence       │ ───────► │  outbound only         │
 └──────────────────────┘          └────────────────────────┘
              ▲                              │
              └──────────┬───────────────────┘
                  relaydesk relay
             (one process, JSON file, SSE)
```

## Why this exists

Two very popular projects solve adjacent halves of the same problem, and both
have a platform cliff:

| | what it does | the cliff |
|---|---|---|
| [Yobiru](https://github.com/chekusu/yobiru) | lets agents on different machines message each other | every node must be a Tailscale node; the Codex bridge is macOS/Linux only |
| [REA](https://github.com/morluto/rea) | MCP bridge from an agent to Ghidra/Hopper/IDA and other RE tools | Hopper has no Windows build; Windows is an experimental read-only Ghidra P0; several lanes are Linux x64 only |

`relaydesk` keeps the useful shape — **a phone as the interface, a real computer as
the executor, and a durable record in between** — and removes the parts that
tied it to one OS or one network:

- no Tailscale requirement; the relay is plain HTTP on your LAN (or behind any
  tunnel you already use),
- the phone is never a compute node and never needs Node, Python or a binary,
- the worker only makes **outbound** requests, so it works behind NAT, in WSL,
  on Windows, on ARM, in a container,
- capability routing instead of a hardcoded tool list: a worker advertises what
  it can do, the relay only gives it matching jobs.

## Quick start

Requires Node.js 22+ on the machine that runs the relay and the worker. The
phone needs only a browser.

```bash
git clone https://github.com/AIMetaPhD/relaydesk.git && cd relaydesk
node bin/relaydesk.mjs serve
```

The relay prints a LAN URL and a one-time pairing token:

```
  local      http://127.0.0.1:7331
  lan        http://192.168.1.3:7331  (WLAN)
  pairing    86a9101506e6de1d
```

Open the LAN URL on the phone, type the token once, and the browser holds a
session cookie from then on.

Then start a worker **on the computer that can actually reach the files and the
tooling**:

```bash
RELAYDESK_TOKEN=86a9101506e6de1d node bin/relaydesk.mjs worker --relay http://127.0.0.1:7331
```

Queue a request from the phone — `file.kind` on a path, `tool.probe` to see what
that worker has installed — and watch the result appear in the case.

One-command local demo (relay + worker in one process):

```bash
node bin/relaydesk.mjs demo
```

## What ships today

| capability | what it returns |
|---|---|
| `file.kind` | size, SHA-256, extension, timestamps |
| `file.hash` | SHA-256 and byte count |
| `tool.probe` | which of `objdump`, `readelf`, `file`, `strings`, `jadx`, `ghidra` exist on the worker |
| `binary.strings` | printable strings, deduplicated |
| `binary.objdump` | GNU objdump headers or disassembly |

Capabilities are ~20 lines each in [`src/analysis/capabilities.mjs`](src/analysis/capabilities.mjs).
Adding `ghidra.decompile` or a `jadx.manifest` lane is meant to be a small,
reviewable change, not a new subsystem. Inputs are validated against the
capability's declared schema first: unknown keys, missing required fields and
non-object inputs are rejected before any tool runs.

A job that no connected worker advertises is failed after 10 minutes with
`no worker took this job`, so a phone never waits on a request that can never
run. A worker that dies mid-job leaves its job `running` — there is no
lease/heartbeat-based recovery yet.

## MCP

The same capability registry is exposed over stdio, so an agent can use the
worker's tools directly:

```bash
node bin/relaydesk.mjs mcp
```

With `RELAYDESK_RELAY_URL` and `RELAYDESK_TOKEN` set, the MCP server also exposes
`relaydesk_create_case`, `relaydesk_request`, `relaydesk_job`, `relaydesk_workers`
and `relaydesk_state`, which is how an agent writes into the same case file the
phone is reading.

Claude Code registration:

```bash
claude mcp add relaydesk -- node /absolute/path/to/relaydesk/bin/relaydesk.mjs mcp
```

## Design notes

- **One JSON file, atomic writes.** The store writes to a temp file and renames,
  so a crash mid-write does not corrupt the case. No database, no migrations.
- **Long-poll, not sleep.** Workers hold a 25-second poll open; a request queued
  from a phone is picked up in well under a second.
- **The pairing token is a long-lived credential, not a one-time code.** It is
  16 hex characters, printed once, stored `0600` on POSIX (Windows ignores that
  mode and relies on the user-profile ACL), and it authenticates both browser
  pairing and `/worker/*`. It does not expire. Rotate it by deleting
  `~/.relaydesk/pairing-token` and restarting the relay — that invalidates
  every existing worker and session.
- **Evidence, not verdicts.** Each entry records where it came from
  (`browser`, `worker:<id>`) and what it is (`request`, `result`, `note`).

## What this deliberately does not do

- **No cloud, no account, no telemetry.** The relay is a process on your machine.
- **No TLS termination.** Put it behind Tailscale, a reverse proxy, or your own
  tunnel if the LAN is not trusted. Plain HTTP on a shared network is a real
  risk, not a theoretical one: the pairing token travels in clear text and
  grants full worker access to anyone who captures it. Bind to a specific
  interface with `--host` rather than leaving `0.0.0.0` on an untrusted LAN.
- **No RBAC.** There is one pairing token; everyone who pairs sees everything.
- **No exactly-once delivery.** If a worker goes silent mid-job the relay puts
  the job back in the queue once; if that happens twice the job is failed. A
  worker that completes work but loses its result before reporting can still
  cause the job to run twice — the evidence will show it.
- **No decompiler.** It routes to tools you already have; it does not bundle
  Ghidra, Hopper, IDA or JADX.
- **Not a sandbox.** A worker runs with your user's permissions on any path you
  give it. Only pair relays and workers you control.

## Running it unattended

Autostart without a console window, interface binding, token handling, and the
recovery behaviour of queued, lost and requeued jobs are in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Platform support

| host | relay | worker | UI |
|---|---|---|---|
| Windows 11 x64 | tested | tested | tested |
| Windows 10 x64 | expected, untested | expected, untested | expected, untested |
| Windows on ARM | untested | untested | untested |
| macOS (Intel / Apple silicon) | untested | untested | untested |
| Linux x64 / arm64 | untested | untested | untested |
| Android / iOS browser | — | — | untested on a device; verified at 375 px and 812 px viewport sizes |
| Windows 10 Mobile (EOL 2020-01) | — | — | no support |

Nothing in the runtime is OS-specific — no native addon, no platform branch, no
`socket()`/named-pipe assumption — but "no platform branch" is not the same as
"tested there". Only the Windows 11 x64 row was exercised by a human on real
hardware. Test reports for the others are welcome.

The only native dependency is whatever the worker's capabilities shell out to.
Nothing in the relay or the worker is OS-specific.

## Status

Version 0.1.1. Thirteen tests pass (`node --test`), stable across repeated runs
and in a checkout path containing spaces and non-ASCII characters. The UI was verified
in a headless browser at a 375 px viewport: pairing, case creation, request
dispatch over long-poll, worker round trip and SSE updates all work.

If this demo gets no interest, it should stay a demo. Issues and small pull
requests are welcome; a rewrite of the storage layer is not.

## License

MIT.
