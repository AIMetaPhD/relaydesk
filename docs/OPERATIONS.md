# Running relaydesk unattended

The demo works from a terminal. This page is the part you need once you want it
to survive a reboot. Everything here was checked against the code; the Windows
scheduler steps were reviewed by a second reader and are marked where they are
still untested.

## 1. Do not put the token on the command line

`--token` is supported, but every local process can read another process's
command line. Use the environment variable:

```bash
RELAYDESK_TOKEN=<token> relaydesk worker --relay http://127.0.0.1:7331
```

PowerShell:

```powershell
$env:RELAYDESK_TOKEN = '<token>'
relaydesk worker --relay http://127.0.0.1:7331
```

On Windows the token file is only protected by the user profile ACL — `0600` is
a POSIX mode and Windows ignores it. Treat the data directory as a secret.

## 2. Bind the relay deliberately

`relaydesk serve` binds `0.0.0.0` so a phone on the LAN can reach it. That is
the point, and it is also the risk: there is no TLS, and the pairing token is a
long-lived credential for both browser pairing and `/worker/*`.

- Trusted LAN, or the machine is behind Tailscale / a reverse proxy → `0.0.0.0`
  is fine.
- Shared or untrusted network → `--host 127.0.0.1` plus your own tunnel.
- Rotate by deleting `<data>/pairing-token` and restarting. This invalidates
  every worker and every browser session.

Use a hostname or a stable address for `--relay`. A literal DHCP address stops
working the first time the lease changes.

## 3. Windows: start at boot without a console window

Use Task Scheduler rather than a startup folder shortcut. The folder shortcut
only runs after an interactive logon, has no restart policy, and has no
single-instance protection.

Relay (runs whether or not a user is logged on):

```powershell
schtasks /create /tn "relaydesk relay" /sc onstart /ru SYSTEM /f /tr `
  "\"C:\Program Files\nodejs\node.exe\" \"C:\relaydesk\bin\relaydesk.mjs\" serve --data C:\relaydesk\data"
```

Notes:

- `node.exe` may flash a console window. If your Node build ships `nodew.exe`
  (windowless), use that instead.
- With `/ru SYSTEM`, `%USERPROFILE%` resolves to the service profile. Always
  pass `--data` explicitly or the token ends up somewhere you will not find it.
- Output goes nowhere under Task Scheduler. Redirect it to a file if you want
  logs; the relay prints one JSON line per lifecycle event.

In the task's properties, set **If the task is already running → Do not start a
new instance**. That, not port collision, is what prevents a second relay from
splitting state across two data directories.

Worker (per user, at logon):

```powershell
schtasks /create /tn "relaydesk worker" /sc onlogon /f /tr `
  "cmd /c \"set RELAYDESK_TOKEN=<token>&& \"C:\Program Files\nodejs\node.exe\" \"C:\relaydesk\bin\relaydesk.mjs\" worker --relay http://127.0.0.1:7331\""
```

The worker now retries registration with backoff, so starting it before the
relay is listening is safe.

## 4. Linux and macOS

`systemd --user` and `launchd` both give you restart-on-failure and a single
instance. The shape is the same as the Windows task: run `relaydesk serve` with
an explicit `--data`, then `relaydesk worker` with `RELAYDESK_TOKEN` in the
unit's environment. Keep the token in an `EnvironmentFile` readable only by
your user, not inline in the unit.

## 5. Health and recovery

- `GET /healthz` on the relay returns `{ok, uptime_s}` and needs no auth. It
  proves the process is listening, nothing else.
- Watch the worker by its log line rate: an idle worker still writes a line
  when it takes and finishes a job, and errors are logged with `retry_in_ms`.
  A worker that has produced nothing for several minutes while jobs are queued
  is the case to investigate.
- A job that no worker can run fails after 10 minutes with
  `no worker took this job`.
- A job whose worker goes silent is requeued once after 5 minutes and failed if
  it happens again. Both events are recorded in the case, and the second one
  says so plainly instead of leaving the phone waiting.

## 6. Restart safety

The relay writes its state to a single JSON file with write-and-rename, and
flushes are serialized. A hard kill can lose the last event, not corrupt the
file. Two relays must never share one `--data` directory: last writer wins and
you will silently lose evidence.
