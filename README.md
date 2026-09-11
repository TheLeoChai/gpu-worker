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
| `host_info` | CPU/RAM/disk + GPU name, VRAM, utilization (via `nvidia-smi`) |
| `gpu_status` | GPU utilization, memory, temperature + running compute apps |
| `run_job` | Enqueue `{ repo, ref?, command, timeout_minutes? }`. Known short names (`leos-opencode`, `ai-society`) or any git URL. Returns `jobId` |
| `job_status` | `queued \| running \| done \| failed \| timeout \| cancelled` + exit code + timestamps |
| `job_log` | Tail of the job's combined stdout/stderr |
| `cancel_job` | Cancel queued or kill running job (whole process tree) |
| `list_jobs` | Recent jobs with statuses |

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
- Optional IP allowlist via `GPU_WORKER_ALLOWED_IPS` (comma-separated).

### Job lifecycle
```
enqueue ──▶ queued ──▶ running ──▶ done | failed | timeout | cancelled
                │           │
                └─ cancel   └─ cancel kills process tree (taskkill /T /F)
```
- `run_job` rejects immediately (before queueing) if workspace drive free space < `GPU_WORKER_MIN_FREE_GB`.
- Each job gets an isolated workspace: `<WORKSPACES>/<jobId>/`, clone with `--no-checkout`, checkout `ref` (fetches it if missing), then the command runs with `cwd` = repo root via `cmd.exe`, with `GPU_WORKER_JOB_ID` in the environment.
- Output is streamed to `job.log` (10 MB cap per job); on completion the log is copied to `logs/<jobId>.log` and the workspace becomes eligible for retention sweeps.
- History is capped at 100 jobs in `jobs.json`.

## Files

| Path | Purpose |
|---|---|
| `server.js` | HTTP + MCP server, auth, nvidia-smi tools, Tailscale binding |
| `jobs.js` | Queue, job runner, retention sweeps, orphan cleanup |
| `tray/GpuWorkerTray.cs` | Tray app source (C# / WinForms, compiled with .NET Framework `csc`) |
| `GpuWorkerTray.exe` | Compiled tray app |
| `auth.env` | Bearer token (**secret, gitignored**) |
| `jobs.json` | Persisted job state (**runtime, gitignored**) |
| `start-worker.cmd` / `stop-worker.cmd` | Start/stop worker (portable, use `%~dp0`) |
| `launch-worker.vbs`, `*-hidden.vbs` | Silent wrappers for scheduled tasks / tray |
| `smoke-client.js` | End-to-end smoke test (connect, list tools, run a job) |
| `check-fs.js`, `status-one.js`, `retention-e2e.js` | Maintenance/test helpers |
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
