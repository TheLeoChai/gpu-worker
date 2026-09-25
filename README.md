# GPU Worker

A self-hosted **remote job runner for your desktop GPU PC** (built for an RTX 4090), exposed to your other machines as an **MCP (Model Context Protocol) server over HTTP**. It ships with a Windows system-tray app so the whole thing comes alive at logon with zero interaction.

```
                                    Tailscale / LAN
 other machines  ──MCP over HTTP──▶  ┌─────────────────────────────────────────────┐
 (opencode, claude, ──────────────▶  │  GPU PC (Windows)                           │
  scripts, curl)    Bearer token     │                                             │
                                     │  GpuWorkerTray.exe (system tray)            │
                                     │    └─ auto-starts ─▶ node server.js         │
                                     │                        │  127.0.0.1:4120    │
                                     │                        └─  <tailscale-ip>:4120
                                     │                        │                    │
                                     │                   jobs.js (FIFO queue)      │
                                     │                        │                    │
                                     │              git clone ─▶ cmd.exe in        │
                                     │              isolated workspace (F:)        │
                                     └─────────────────────────────────────────────┘
```

## What it does

- **Runs shell jobs on your GPU PC from anywhere in your tailnet.** A job = *clone a git repo at a given ref, run a command inside it, collect the log*. One job runs at a time, FIFO.
- **MCP server**: AI assistants and scripts connect with a standard MCP client and call tools like `run_job` / `job_status` / `job_log`.
- **Tray app**: shows worker state at a glance (red = stopped, orange = running but no Tailscale, green = idle, blue = job running), shows/queues running + queued jobs, and can Start / Stop / Restart the worker. It **auto-starts the worker at logon** if it isn't running.
- **Tailscale-aware**: the server binds loopback immediately, then keeps watching for the Tailscale IPv4 and binds it as soon as it appears (handles slow boots; never gives up). Remote clients reach `http://<machine>:4120`.
- **Crash-safe**: job state persists in `jobs.json`; on restart, orphaned processes from interrupted jobs are killed and jobs are marked failed. Queued jobs survive only while the service runs (by design).
- **Disk hygiene**: workspaces are reclaimed automatically — the newest N completed workspaces are kept (default 3), older ones purged; every job's log is preserved in `logs/`. Jobs are rejected up-front if the workspace drive falls below a minimum free-space threshold.

## MCP tools

| Tool | Description |
|---|---|
| `host_info` | CPU/RAM/disk + GPU name, VRAM, utilization (via `nvidia-smi`) + allowlisted `artifactRoots` |
| `gpu_status` | GPU utilization, memory, temperature + running compute apps |
| `run_job` | Enqueue `{ repo, ref?, command, timeout_minutes? }`. Known short names (`leos-opencode`, `ai-society`) or any git URL. Returns `jobId` |
| `job_status` | `queued \| running \| done \| failed \| timeout \| cancelled` + exit code + timestamps + `checkoutDrift` (files whose checked-out bytes differ from the commit) |
| `job_log` | Tail of the job's combined stdout/stderr |
| `cancel_job` | Cancel queued or kill running job (whole process tree) |
| `list_jobs` | Recent jobs with statuses |
| `list_job_artifacts` | Read-only manifest (size + `sha256` + download URL per file) of a job workspace or an allowlisted checkout |
| `get_job_artifact` | One bounded, resumable chunk of a single artifact file (base64 or utf8) |

## Client setup

Any MCP-capable client can use it (streamable HTTP transport). Example JSON config:

```json
{
  "mcpServers": {
    "desktop-gpu": {
      "type": "http",
      "url": "http://kawaii-4090-pc:4120/mcp",
      "headers": { "Authorization": "Bearer <GPU_WORKER_TOKEN>" }
    }
  }
}
```

Or test it manually:

```powershell
# health (no auth needed)
curl http://<host>:4120/health

# MCP call (auth required)
node smoke-client.js http://127.0.0.1:4120
```

## How it works

### Boot flow (fully automatic)
1. Windows logon runs `GpuWorkerTray.exe` (registry `HKCU\...\Run` key `GpuWorkerTray`).
2. The tray sees no `node server.js` process and **auto-starts it** (hidden, via `start-worker.cmd`).
3. `server.js` binds `127.0.0.1:4120` immediately, recovers interrupted jobs, and starts the **Tailscale watcher**: every 10 s it queries `tailscale ip -4` and binds the first `100.x.x.x` address it finds.
4. The tray polls both endpoints; the icon turns green once the Tailscale listener answers.

### Auth
- Every non-`/health` request requires `Authorization: Bearer <token>`.
- The token lives in `auth.env` (gitignored): `GPU_WORKER_TOKEN=<random secret>`.
- Token comparison is constant-time (`crypto.timingSafeEqual`).
- Optional restricted token for delegated agents: `GPU_WORKER_AGENT_TOKEN=<another secret>` in the same `auth.env` (see [Subagent access](#subagent-access)).
- Optional IP allowlist via `GPU_WORKER_ALLOWED_IPS` (comma-separated).

### Job lifecycle
```
enqueue ──▶ queued ──▶ running ──▶ done | failed | timeout | cancelled
                │           │
                └─ cancel   └─ cancel kills process tree (taskkill /T /F)
```
- `run_job` rejects immediately (before queueing) if workspace drive free space < `GPU_WORKER_MIN_FREE_GB`.
- Each job gets an isolated workspace: `<WORKSPACES>/<jobId>/`, clone with `--no-checkout`, checkout `ref` (fetches it if missing), then the command runs with `cwd` = repo root via `cmd.exe`, with `GPU_WORKER_JOB_ID` and `GPU_WORKER_TOOLS` (this repo's `tools\` dir) in the environment.
- After checkout the worker compares every file against its committed blob and logs a warning (plus `checkoutDrift` in `job_status`) for bytes rewritten without a `.gitattributes` rule, then logs the GPU compute apps it sees right before launch. Both are diagnostics only; they never block the job.
- Output is streamed to `job.log` (10 MB cap per job); on completion the log is copied to `logs/<jobId>.log` and the workspace becomes eligible for retention sweeps.
- History is capped at 100 jobs in `jobs.json`.

## Artifact retrieval (read-only)

Job logs summarise; audits need the bytes. `list_job_artifacts` / `get_job_artifact` and the
`/artifact` HTTP endpoint hand out **copies** of files already on the PC (LEO-184) — no job runs,
nothing is written, committed, pushed or published, and the source tree is never modified.

Two scopes, exactly one per call:

| Scope | Addresses | Notes |
|---|---|---|
| `jobId` | that job's retained workspace | only while the workspace is inside the keep-N window (see `retainedWorkspaces`) |
| `root` | an allowlisted persistent checkout | names come from `GPU_WORKER_ARTIFACT_ROOTS`, listed in `host_info.artifactRoots` |

```
GPU_WORKER_ARTIFACT_ROOTS=ai-society=F:\Github\AI-society;other=D:\some\dir   # default: the ai-society entry
GPU_WORKER_ARTIFACT_HASH_MAX_GB=8                                             # refuse to hash more than this per manifest
```

Typical audit flow (all read-only, from any machine on the tailnet):

```bash
# 1. manifest: every file with size + sha256 + its download URL
node mcp-call.mjs list_job_artifacts '{"root":"ai-society","path":"results/.../runtime_receipts/attempt_1"}'

# 2. copy the whole directory to Linux and verify it against that manifest
GPU_WORKER_TOKEN=<token> node tools/fetch-artifacts.mjs \
  --host http://<host>:4120 --root ai-society \
  --path results/.../runtime_receipts/attempt_1 --out /tmp/attempt_1
# -> FETCH_OK files=<n> bytes=<n> copied=<n> manifest=/tmp/attempt_1.manifest.json

# 3. or pull a single file/chunk by hand
curl -H "Authorization: Bearer <token>" \
  "http://<host>:4120/artifact/root/ai-society/results/.../seal.json?sha256=1" -o seal.json
```

`GET|HEAD /artifact/<job|root>/<name>/<relative/path>` (same Bearer token as `/mcp`, same tailnet
port, no public endpoint):

- `?manifest=1[&hashes=0]` on a directory → JSON manifest; a plain `GET` on a file → its bytes.
- `Accept-Ranges: bytes`; `Range` requests answer `206` with `Content-Range`, so an interrupted
  copy resumes instead of restarting. Unsatisfiable ranges → `416`.
- `ETag` = size+mtime. Send `If-Match` when resuming: a source file that changed answers `412`
  rather than splicing mismatched bytes. `?sha256=1` adds an `X-Artifact-SHA256` header.
- `POST`/`PUT`/`DELETE` → `405`. Absolute paths, drive letters, UNC, `..` and symlinks → `400`;
  missing artifacts → `404`; purged workspaces → `404` naming the retention window.
- `get_job_artifact` caps a chunk at 1 MiB (default 64 KiB) — it exists for peeking at a file,
  not for moving gigabytes through an LLM transcript; use the HTTP endpoint or the fetch tool.

`tools/fetch-artifacts.mjs` is the copy-only client: it fetches the manifest, downloads each file
(resuming from `<file>.part`, discarding a partial whose `ETag` no longer matches), verifies every
sha256 before renaming into place, and writes the manifest next to the copy as
`<out>.manifest.json`. It exits non-zero on any size/hash mismatch.

## Transfer-bundle tools

The GPU PC's global git config has `core.autocrlf=true`, so any file without a `.gitattributes` rule is checked out with CRLF line endings. Anything hash-bound to committed bytes breaks (LEO-182). Three stdlib-only tools in `tools/` cover the recurring transfer failures. Jobs reach them through `%GPU_WORKER_TOOLS%`.

| Tool | Run it | Fails when |
|---|---|---|
| `verify-checkout.js [--require-eol-lock] [--json] [path...]` | first step of the job's launcher on the PC; also on the builder before submitting | a tracked file's working-tree bytes differ from its committed blob, or (with `--require-eol-lock`) a file lacks an eol lock |
| `import_closure.py ENTRY.py... --root REPO [--path DIR]... [--bundle DIR] [--out import_map.json]` | on the bundle builder, before freezing the bundle | an import (including function-level and `importlib.import_module("x")` imports) names a repo module outside the search path, or `--bundle` is missing a closure file or has different bytes |
| `gpu_idle_check.py [--probes 3] [--interval 5]` (or `from gpu_idle_check import wait_for_idle_gpu`) | in the job's GPU preflight, instead of one `nvidia-smi` probe | every probe (3 over ~10 s by default) saw a compute process. The JSON result lists each probe's processes so the refusal receipt can be diagnosed |

Transfer checklist rules:

1. **Every transfer dir carries an eol lock.** Its `.gitattributes` must mark the files `-text` (or `text eol=lf`). This includes wrappers that get hash-verified. `node "%GPU_WORKER_TOOLS%\verify-checkout.js" --require-eol-lock results\<dir>` enforces this, so run it before any hash check and refuse on a non-zero exit.
2. **Import lists are generated, never hand-written.** Build `import_map.json` with `import_closure.py` from the bundle's entry scripts, then re-run with `--bundle <extracted dir>`. Keep the isolated import dry-run as the last gate.
3. **Occupancy checks retry.** Use `wait_for_idle_gpu()` and put its `probes` in the refusal message.

## Subagent access

The owner token stays with the orchestrator. To let agent-hub subagents submit jobs directly, add a second secret to `auth.env` (`GPU_WORKER_AGENT_TOKEN=...`), restart the worker, and pass the server as an ACP entry in `agent_dispatch`:

```json
"mcp_servers": [{
  "type": "http", "name": "desktop-gpu",
  "url": "http://100.107.19.56:4120/mcp",
  "headers": [{ "name": "Authorization", "value": "Bearer <GPU_WORKER_AGENT_TOKEN>" }]
}]
```

The worker enforces the guardrails whichever token is used. Only the agent-specific ones depend on the agent token:

| Guardrail | Enforcement |
|---|---|
| serialized jobs | single FIFO queue, one job at a time (all tokens) |
| ≥100 GB free before a job | `run_job` refuses below `GPU_WORKER_MIN_FREE_GB` (all tokens) |
| never terminate healthy jobs | agent token: `cancel_job` only works on **queued** jobs submitted with the agent token; running jobs need the owner |
| no `cleanup_persistent_results.py` | agent token: `run_job` rejects commands that mention it |

Jobs record `submittedBy` (`owner` / `agent`) in `job_status` and `list_jobs`. The ACP adapter must support HTTP MCP servers (`mcpCapabilities.http`). If a provider doesn't support them, that provider stays orchestrator-only, and its dispatch prompts must not assume the tools exist.

## Files

| Path | Purpose |
|---|---|
| `server.js` | HTTP + MCP server, auth, nvidia-smi tools, Tailscale binding |
| `jobs.js` | Queue, job runner, retention sweeps, orphan cleanup |
| `artifacts.js` | Read-only artifact scopes, path validation, manifests, chunk/range reads |
| `tray/GpuWorkerTray.cs` | Tray app source (C# / WinForms, compiled with .NET Framework `csc`) |
| `GpuWorkerTray.exe` | Compiled tray app |
| `auth.env` | Bearer tokens: owner + optional agent (**secret, gitignored**) |
| `jobs.json` | Persisted job state (**runtime, gitignored**) |
| `start-worker.cmd` / `stop-worker.cmd` | Start/stop worker (portable, use `%~dp0`) |
| `launch-worker.vbs`, `*-hidden.vbs` | Silent wrappers for scheduled tasks / tray |
| `smoke-client.js` | End-to-end smoke test (connect, list tools, run a job) |
| `check-fs.js`, `status-one.js`, `retention-e2e.js` | Maintenance/test helpers |
| `artifacts-e2e.js` | Self-contained artifact-retrieval e2e (spawns its own server on port 4199; submits no jobs) |
| `tools/` | Transfer-bundle tools, exposed to jobs as `%GPU_WORKER_TOOLS%` (see above) |
| `tools/fetch-artifacts.mjs` | Copy-only artifact fetcher (manifest + resumable download + sha256 verify) |
| `logs/` | Preserved per-job logs + `worker.log` / `tray.log` (**gitignored**) |

## Install (fresh machine)

1. Install Node.js 18+, Git, Tailscale, and `nvidia-smi` (NVIDIA driver). For the tray: .NET Framework 4.x (preinstalled on Windows 10/11).
2. Clone this repo to any folder (e.g. `F:\gpu-worker`). All scripts are path-portable.
3. `npm install`
4. Create `auth.env`: `GPU_WORKER_TOKEN=$(node -e "console.log(crypto.randomUUID())")`
5. Build the tray (optional, only if you changed the source):
   ```powershell
   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe `
     /out:GpuWorkerTray.exe /r:System.Web.Extensions.dll /r:System.Management.dll `
     tray\GpuWorkerTray.cs
   ```
6. Start the tray. Add it to autostart: `shell:startup` shortcut, or
   `reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v GpuWorkerTray /d "<path>\GpuWorkerTray.exe" /f`

## Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `GPU_WORKER_PORT` | `4120` | HTTP port |
| `GPU_WORKER_AUTH` | `<dir>\auth.env` | Token file path |
| `GPU_WORKER_ALLOWED_IPS` | *(all)* | Comma-separated client IP allowlist |
| `GPU_WORKER_TS_IP` | *(auto-detect)* | Skip Tailscale auto-detection, bind this IP |
| `GPU_WORKER_WORKSPACES` | `F:\gpu-worker-workspaces` | Job workspace root |
| `GPU_WORKER_KEEP_WORKSPACES` | `3` | Completed workspaces retained (0 = delete all) |
| `GPU_WORKER_MIN_FREE_GB` | `100` | Reject jobs below this free space |
| `GPU_WORKER_LOGS_DIR` | `<dir>\logs` | Preserved job logs |
| `GPU_WORKER_JOBS_FILE` | `<dir>\jobs.json` | Job state file |

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| Tray icon **red** | Worker not running — right-click tray → Start |
| Tray icon **orange** | Worker up, Tailscale listener down — check `tailscale status`; the watcher retries every 10 s and will bind automatically |
| Tray icon **green/blue** but client can't connect | Wrong token in client config, or client not on the tailnet |
| `worker.log` shows `listening on 100.x.x.x:4120` | Tailscale side is fine — problem is client-side |
| Job stuck "running" forever | Check `job_log`; timeout kills at `timeout_minutes` (max 240) |

## Security notes

- The bearer token grants **arbitrary command execution** on this machine. Treat it like a root password; never commit `auth.env`.
- `/health` is the only unauthenticated endpoint and returns no sensitive data.
- Restrict exposure by keeping port 4120 bound only to loopback + Tailscale (default), and optionally set `GPU_WORKER_ALLOWED_IPS`.
