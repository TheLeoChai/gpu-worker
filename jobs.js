"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { verifyCheckout } = require("./tools/verify-checkout.js");

const ROOT = __dirname;
const TOOLS_DIR = path.join(ROOT, "tools");
const WORKSPACES = process.env.GPU_WORKER_WORKSPACES || "F:\\gpu-worker-workspaces";
const LOGS_DIR = process.env.GPU_WORKER_LOGS_DIR || path.join(ROOT, "logs");
const JOBS_FILE = process.env.GPU_WORKER_JOBS_FILE || path.join(ROOT, "jobs.json");
const LOG_CAP_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY = 100;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const ORPHAN_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_WORKSPACES = Math.max(0, parseInt(process.env.GPU_WORKER_KEEP_WORKSPACES || "3", 10) || 0);
const MIN_FREE_GB = Math.max(0, parseFloat(process.env.GPU_WORKER_MIN_FREE_GB || "100"));

function exec(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        windowsHide: true,
        timeout: opts.timeout || 15000,
        cwd: opts.cwd || undefined,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

async function killTree(pid) {
  const r = await exec("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 20000 });
  return r.ok;
}

// Kill only processes whose command line references this job's workspace dir.
async function killOrphansFor(jobId) {
  const marker = WORKSPACES + "\\" + jobId;
  const ps =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" +
    marker.replace(/'/g, "''") +
    "*' } | Select-Object -ExpandProperty ProcessId";
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 });
  if (!r.ok) return [];
  const pids = r.stdout
    .split(/\r?\n/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0);
  for (const pid of pids) await killTree(pid);
  return pids;
}

let jobs = {};
let queueOrder = [];
let runningId = null;
const cancelWaiters = new Map();

function persistJobs() {
  const data = { jobs, queueOrder, runningId };
  const tmp = JOBS_FILE + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, JOBS_FILE);
  } catch (e) {
    console.error("[worker] persistJobs failed:", (e && e.message) || e);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

function loadJobs() {
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
    jobs = data.jobs || {};
    queueOrder = Array.isArray(data.queueOrder)
      ? data.queueOrder.filter((id) => jobs[id] && jobs[id].status === "queued")
      : [];
    // prune history
    const ids = Object.keys(jobs);
    if (ids.length > MAX_HISTORY) {
      ids
        .sort((a, b) => String(jobs[a].queuedAt || "").localeCompare(String(jobs[b].queuedAt || "")))
        .slice(0, ids.length - MAX_HISTORY)
        .forEach((id) => delete jobs[id]);
    }
  } catch (e) {
    jobs = {};
    queueOrder = [];
  }
  runningId = null;
}

async function recoverOnBoot() {
  loadJobs();
  for (const id of Object.keys(jobs)) {
    const j = jobs[id];
    if (j.status === "running") {
      let killed = [];
      try {
        killed = await killOrphansFor(id);
      } catch (e) {}
      j.status = "failed";
      j.error = "interrupted by service restart" + (killed.length ? " (killed orphaned pids: " + killed.join(",") + ")" : "");
      j.endedAt = new Date().toISOString();
      j.pid = null;
      appendLog(j, "[worker] interrupted by service restart\r\n");
    } else if (j.status === "queued" && !queueOrder.includes(id)) {
      j.status = "failed";
      j.error = "interrupted by service restart";
      j.endedAt = new Date().toISOString();
    }
  }
  persistJobs();
  sweepWorkspaces();
  setInterval(sweepWorkspaces, SWEEP_INTERVAL_MS).unref();
}

function appendLog(j, text) {
  try {
    if (!text) return;
    if (j.logBytes >= LOG_CAP_BYTES) return;
    const len = Buffer.byteLength(text);
    const trimmed = j.logBytes + len > LOG_CAP_BYTES ? text.slice(0, Math.max(0, LOG_CAP_BYTES - j.logBytes)) : text;
    fs.appendFileSync(path.join(WORKSPACES, j.id, "job.log"), trimmed);
    j.logBytes += Buffer.byteLength(trimmed);
  } catch (e) {}
}

function preserveLog(j) {
  try {
    const src = path.join(WORKSPACES, j.id, "job.log");
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.copyFileSync(src, path.join(LOGS_DIR, j.id + ".log"));
  } catch (e) {}
}

function deleteWorkspace(id) {
  const ws = path.join(WORKSPACES, id);
  try {
    if (fs.existsSync(ws)) {
      fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      console.log("[worker] cleaned workspace " + id);
    }
  } catch (e) {
    console.error("[worker] failed to clean workspace " + id + ": " + ((e && e.message) || e));
  }
}

function freeDiskGB() {
  try {
    const s = fs.statfsSync(WORKSPACES);
    return (s.bsize * s.bavail) / 1024 ** 3;
  } catch (e) {
    return null;
  }
}

function assertDiskSpace() {
  const free = freeDiskGB();
  if (free !== null && free < MIN_FREE_GB) {
    throw new Error(
      "insufficient disk space on workspace drive: " + free.toFixed(1) + " GB free, " +
      MIN_FREE_GB + " GB required (tune with GPU_WORKER_MIN_FREE_GB; free space is reported by host_info)"
    );
  }
}

// Enforce workspace retention: never touch queued/running jobs; of the
// completed/unknown workspace dirs, keep the KEEP_WORKSPACES newest (by job
// endedAt, falling back to dir mtime), delete the rest.
function sweepWorkspaces() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(WORKSPACES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    return;
  }
  const active = (id) => {
    const j = jobs[id];
    return j && (j.status === "running" || j.status === "queued");
  };

  const keep = new Set();
  if (KEEP_WORKSPACES > 0) {
    const candidates = dirs
      .filter((id) => !active(id))
      .map((id) => {
        const j = jobs[id];
        let time = j && j.endedAt ? Date.parse(j.endedAt) : NaN;
        if (!Number.isFinite(time)) {
          try { time = fs.statSync(path.join(WORKSPACES, id)).mtimeMs; } catch (e) { time = 0; }
        }
        return { id, time: Number.isFinite(time) ? time : 0 };
      })
      .sort((a, b) => b.time - a.time);
    candidates.slice(0, KEEP_WORKSPACES).forEach((c) => keep.add(c.id));
  }

  for (const id of dirs) {
    if (active(id) || keep.has(id)) continue;
    deleteWorkspace(id);
  }
  try {
    if (!fs.existsSync(LOGS_DIR)) return;
    const ids = new Set(Object.keys(jobs));
    const cutoff = Date.now() - ORPHAN_LOG_MAX_AGE_MS;
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const m = f.match(/^(.+)\.log$/);
      if (!m || ids.has(m[1])) continue;
      const p = path.join(LOGS_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (e) {}
    }
  } catch (e) {}
}

function pumpQueue() {
  if (runningId) return;
  while (queueOrder.length) {
    const id = queueOrder.shift();
    if (jobs[id] && jobs[id].status === "queued") {
      persistJobs();
      runningId = id;
      runJob(id).catch(() => {});
      return;
    }
  }
}

const REPOS = {
  "leos-opencode": { url: "https://github.com/TheLeoChai/leos-opencode.git", branch: "leos-opencode" },
  "ai-society": { url: "git@github.com:TheLeoChai/AI-society.git", branch: "main" },
};

function resolveRepo(repo) {
  if (REPOS[repo]) return REPOS[repo];
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(repo)) {
    return { url: repo, branch: null };
  }
  throw new Error("unknown repo: " + repo);
}

async function runJob(id) {
  const j = jobs[id];
  j.startedAt = new Date().toISOString();
  j.status = "running";
  persistJobs();

  const ws = path.join(WORKSPACES, id);
  let child = null;
  let timedOut = false;

  try {
    fs.mkdirSync(ws, { recursive: true });
    const info = resolveRepo(j.repo);
    j.url = info.url;

    let r = await exec("git", ["clone", "--no-checkout", info.url, "."], { cwd: ws, timeout: 10 * 60 * 1000 });
    appendLog(j, r.stdout + r.stderr);
    if (!r.ok && !fs.existsSync(path.join(ws, ".git"))) throw new Error("git clone failed: " + r.stderr.slice(-500));

    const target = j.ref || info.branch;
    if (target) {
      let c = await exec("git", ["checkout", target], { cwd: ws, timeout: 120000 });
      appendLog(j, c.stdout + c.stderr);
      if (!c.ok) {
        const f = await exec("git", ["fetch", "origin", target], { cwd: ws, timeout: 10 * 60 * 1000 });
        appendLog(j, f.stdout + f.stderr);
        if (!f.ok) throw new Error("fetch of ref '" + target + "' failed: " + f.stderr.slice(-500));
        c = await exec("git", ["checkout", "FETCH_HEAD"], { cwd: ws, timeout: 120000 });
        appendLog(j, c.stdout + c.stderr);
        if (!c.ok) throw new Error("checkout of ref '" + target + "' failed: " + c.stderr.slice(-500));
      }
      j.checkedOut = target;
    }

    // Diagnostics only (LEO-182): report files whose checked-out bytes differ
    // from the committed blob without .gitattributes asking for it. Jobs that
    // hash-verify should gate on tools/verify-checkout.js themselves.
    try {
      const v = await verifyCheckout(ws);
      const drift = v.drift.filter((d) => !d.intentional);
      if (drift.length) {
        j.checkoutDrift = { count: drift.length, paths: drift.slice(0, 20).map((d) => d.path) };
        appendLog(j, "[worker] WARNING: " + drift.length + " file(s) differ from committed bytes after checkout " +
          "(line-ending rewrite?): " + j.checkoutDrift.paths.join(", ") + "\r\n");
      }
    } catch (e) {
      appendLog(j, "[worker] checkout verification skipped: " + ((e && e.message) || e) + "\r\n");
    }

    // GPU occupancy as seen right before launch, so a job's own preflight
    // refusal can be compared against it (LEO-179).
    const gpuApps = await exec("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader"]);
    appendLog(j, "[worker] GPU compute apps at launch: " + (gpuApps.ok ? gpuApps.stdout.trim() || "(none)" : "(nvidia-smi failed)") + "\r\n");

    child = spawn("cmd.exe", ["/d", "/s", "/c", j.command], {
      cwd: ws,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, { GPU_WORKER_JOB_ID: id, GPU_WORKER_TOOLS: TOOLS_DIR }),
    });
    j.pid = child.pid;
    persistJobs();

    const timeoutMs = j.timeoutMinutes * 60 * 1000;
    const timer = setTimeout(async () => {
      timedOut = true;
      appendLog(j, "\r\n[worker] TIMEOUT after " + j.timeoutMinutes + " min, killing process tree\r\n");
      await killTree(child.pid);
    }, timeoutMs);

    await new Promise((resolve) => {
      child.stdout.on("data", (d) => appendLog(j, d.toString()));
      child.stderr.on("data", (d) => appendLog(j, d.toString()));
      child.on("error", (e) => {
        appendLog(j, "[worker] spawn error: " + e.message + "\r\n");
        j.exitCode = null;
        resolve();
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        j.exitCode = code === null ? null : code;
        j.signal = signal || null;
        if (j.status === "cancelled") {
          // already finalized by cancel_job
        } else if (j.cancelRequested) {
          j.status = "cancelled";
          j.endedAt = new Date().toISOString();
        } else if (timedOut) {
          j.status = "timeout";
          j.endedAt = new Date().toISOString();
        } else if (code === 0) {
          j.status = "done";
          j.endedAt = new Date().toISOString();
        } else {
          j.status = "failed";
          j.endedAt = new Date().toISOString();
        }
        resolve();
      });
    });
  } catch (e) {
    if (j.status !== "cancelled") {
      j.status = "failed";
      j.error = String((e && e.message) || e).slice(0, 1000);
      j.endedAt = new Date().toISOString();
    }
    appendLog(j, "[worker] ERROR: " + String((e && e.message) || e) + "\r\n");
  }

  j.pid = null;

  if (cancelWaiters.has(id)) {
    for (const fn of cancelWaiters.get(id)) fn();
    cancelWaiters.delete(id);
  }

  runningId = null;
  persistJobs();

  // workspace retention: preserve the job log, then reclaim disk space for
  // workspaces beyond the keep-N window (GPU_WORKER_KEEP_WORKSPACES)
  preserveLog(j);
  sweepWorkspaces();

  setImmediate(pumpQueue);
}

function enqueue(repo, ref, command, timeoutMinutes, submittedBy) {
  assertDiskSpace();
  const id = crypto.randomUUID();
  jobs[id] = {
    id,
    repo,
    ref: ref || null,
    command,
    submittedBy: submittedBy || "owner",
    timeoutMinutes: timeoutMinutes > 0 ? Math.min(timeoutMinutes, 240) : 30,
    status: "queued",
    queuedAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    exitCode: null,
    logBytes: 0,
  };
  queueOrder.push(id);
  persistJobs();
  setImmediate(pumpQueue);
  return jobs[id];
}

function getJob(id) {
  return jobs[id] || null;
}

function listJobs() {
  return Object.values(jobs)
    .sort((a, b) => String(b.queuedAt || "").localeCompare(String(a.queuedAt || "")))
    .map((j) => ({
      id: j.id,
      repo: j.repo,
      ref: j.ref,
      command: j.command,
      submittedBy: j.submittedBy || "owner",
      status: j.status,
      queuedAt: j.queuedAt,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      exitCode: j.exitCode,
    }));
}

function jobLogTail(id, tailLines) {
  const j = getJob(id);
  if (!j) return null;
  let content = "";
  for (const file of [path.join(LOGS_DIR, id + ".log"), path.join(WORKSPACES, id, "job.log")]) {
    try {
      content = fs.readFileSync(file, "utf8");
      if (content) break;
    } catch (e) {}
  }
  if (!content) return { lines: [], truncated: false };
  const lines = content.split(/\r?\n/);
  const trailingEmpty = lines.length && lines[lines.length - 1] === "" ? 1 : 0;
  const take = tailLines > 0 ? tailLines : 200;
  return { lines: lines.slice(Math.max(0, lines.length - trailingEmpty - take)), truncated: lines.length > take + trailingEmpty };
}

async function cancelJob(id) {
  const j = getJob(id);
  if (!j) return { ok: false, error: "unknown jobId" };
  if (j.status === "queued") {
    const qi = queueOrder.indexOf(id);
    if (qi >= 0) queueOrder.splice(qi, 1);
    j.status = "cancelled";
    j.endedAt = new Date().toISOString();
    persistJobs();
    return { ok: true, status: "cancelled" };
  }
  if (j.status !== "running" || !j.pid) return { ok: false, error: "job is not running (status=" + j.status + ")" };
  j.cancelRequested = true;
  if (!cancelWaiters.has(id)) cancelWaiters.set(id, []);
  const done = new Promise((resolve) => cancelWaiters.get(id).push(resolve));
  killTree(j.pid);
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 15000))]);
  persistJobs();
  return { ok: true, status: j.status };
}

module.exports = { recoverOnBoot, enqueue, getJob, listJobs, jobLogTail, cancelJob, pumpQueue, sweepWorkspaces, deleteWorkspace, freeDiskGB, KEEP_WORKSPACES, MIN_FREE_GB, WORKSPACES };
