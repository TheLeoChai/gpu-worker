"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const jobman = require("./jobs.js");

const ROOT = __dirname;
const PORT = parseInt(process.env.GPU_WORKER_PORT || "4120", 10);

function loadToken() {
  const envPath = process.env.GPU_WORKER_AUTH || path.join(ROOT, "auth.env");
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*GPU_WORKER_TOKEN\s*=\s*(\S+)\s*$/);
    if (m) return m[1];
  }
  throw new Error("GPU_WORKER_TOKEN not found in " + envPath);
}
const TOKEN_BUF = Buffer.from(loadToken(), "utf8");

let allowedIps = null;
if (process.env.GPU_WORKER_ALLOWED_IPS) {
  allowedIps = new Set(
    process.env.GPU_WORKER_ALLOWED_IPS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function checkAuth(req) {
  if (allowedIps && !allowedIps.has(req.socket.remoteAddress || "")) return false;
  const h = req.headers.authorization || "";
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return false;
  const got = Buffer.from(h.slice(7), "utf8");
  if (got.length !== TOKEN_BUF.length) return false;
  try {
    return crypto.timingSafeEqual(got, TOKEN_BUF);
  } catch (e) {
    return false;
  }
}

function exec(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs || 15000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function nvidiaQuery(fields) {
  const r = await exec("nvidia-smi", ["--query-gpu=" + fields.join(","), "--format=csv,noheader,nounits"]);
  if (!r.ok) return null;
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(",").map((s) => s.trim()));
}

function jsonText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function registerTools(server) {
  server.registerTool(
    "host_info",
    {
      title: "Host Info",
      description:
        "Get desktop GPU worker host info: CPU model/cores, total/free RAM, GPU name/VRAM/utilization via nvidia-smi, and free disk space on the workspace drive.",
      inputSchema: {},
    },
    async () => {
      const cpus = os.cpus();
      const gpuRows = await nvidiaQuery(["name", "memory.total", "memory.used", "utilization.gpu"]);
      let diskFree = null;
      try {
        const s = await fsp.statfs(jobman.WORKSPACES);
        diskFree = Math.round((s.bsize * s.bavail) / 1024 ** 3);
      } catch (e) {}
      return jsonText({
        hostname: os.hostname(),
        platform: os.platform(),
        cpuModel: cpus[0] ? cpus[0].model : null,
        cpuCores: cpus.length,
        ramTotalGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
        ramFreeGB: +(os.freemem() / 1024 ** 3).toFixed(1),
        gpus: (gpuRows || []).map((r) => ({ name: r[0], vramTotalMB: +r[1], vramUsedMB: +r[2], utilizationPct: +r[3] })),
        workspaceDiskFreeGB: diskFree,
        workspaceMinFreeGB: jobman.MIN_FREE_GB,
        retainedWorkspaces: jobman.KEEP_WORKSPACES,
      });
    }
  );

  server.registerTool(
    "gpu_status",
    {
      title: "GPU Status",
      description: "Snapshot of GPU utilization, memory usage, temperature via nvidia-smi, plus running compute apps.",
      inputSchema: {},
    },
    async () => {
      const rows = await nvidiaQuery(["index", "name", "utilization.gpu", "memory.used", "memory.total", "temperature.gpu"]);
      const procs = await exec("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader"]);
      return jsonText({
        gpus: (rows || []).map((r) => ({
          index: +r[0],
          name: r[1],
          utilizationPct: +r[2],
          memUsedMB: +r[3],
          memTotalMB: +r[4],
          tempC: +r[5],
        })),
        computeApps: procs.stdout.trim() || "(none)",
      });
    }
  );

  server.registerTool(
    "run_job",
    {
      title: "Run Job",
      description:
        "Clone/fetch a git repository into an isolated workspace on the desktop GPU PC (RTX 4090) and run a shell command there with cwd=repo root. Jobs queue FIFO; one runs at a time. Known repos: leos-opencode, ai-society; or pass a full git URL. Returns a jobId immediately; poll with job_status. Workspaces are NOT deleted immediately: the last 3 completed workspaces (GPU_WORKER_KEEP_WORKSPACES) are retained for evidence recovery, older ones are purged; job.log is always preserved in gpu-worker\\logs. Jobs are rejected at submit time if the workspace drive has less than the minimum free space.",
      inputSchema: {
        repo: z.string().describe("Short repo name (leos-opencode, ai-society) or full git URL"),
        ref: z.string().optional().describe("Branch, tag or commit to checkout (defaults to repo default branch)"),
        command: z.string().describe("Shell command (cmd.exe) to run inside the workspace"),
        timeout_minutes: z.number().optional().describe("Timeout in minutes, default 30, max 240"),
      },
    },
    async ({ repo, ref, command, timeout_minutes }) => {
      const j = jobman.enqueue(repo, ref, command, timeout_minutes);
      return jsonText({ jobId: j.id });
    }
  );

  server.registerTool(
    "job_status",
    {
      title: "Job Status",
      description: "Status of a submitted job: queued | running | done | failed | timeout | cancelled, with exit code and timestamps.",
      inputSchema: { jobId: z.string().describe("jobId returned by run_job") },
    },
    async ({ jobId }) => {
      const j = jobman.getJob(jobId);
      if (!j) return { isError: true, content: [{ type: "text", text: "unknown jobId" }] };
      return jsonText({
        jobId: j.id,
        status: j.status,
        exitCode: j.exitCode,
        signal: j.signal || null,
        error: j.error || null,
        queuedAt: j.queuedAt,
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        checkedOut: j.checkedOut || null,
      });
    }
  );

  server.registerTool(
    "job_log",
    {
      title: "Job Log",
      description: "Return the tail of a job's combined stdout/stderr output.",
      inputSchema: {
        jobId: z.string().describe("jobId returned by run_job"),
        tailLines: z.number().optional().describe("Number of trailing lines to return (default 200)"),
      },
    },
    async ({ jobId, tailLines }) => {
      const res = jobman.jobLogTail(jobId, tailLines || 200);
      if (!res) return { isError: true, content: [{ type: "text", text: "unknown jobId" }] };
      return jsonText({ truncated: res.truncated, output: res.lines.join("\n") });
    }
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel Job",
      description: "Cancel a queued or running job (kills the process tree of a running job).",
      inputSchema: { jobId: z.string().describe("jobId returned by run_job") },
    },
    async ({ jobId }) => {
      const res = await jobman.cancelJob(jobId);
      return jsonText(res.ok ? res : { ok: false, error: res.error });
    }
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List Jobs",
      description: "List recent jobs on the desktop worker with statuses.",
      inputSchema: {},
    },
    async () => jsonText({ jobs: jobman.listJobs() })
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleMcp(req, res, bodyBuf) {
  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }));
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyBuf.toString("utf8"));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    return;
  }

  const server = new McpServer({ name: "desktop-gpu", version: "1.0.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

async function handler(req, res) {
  const url = req.url || "/";
  if ((req.method === "GET" || req.method === "HEAD") && (url === "/health" || url === "/health/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  if (!checkAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  try {
    const bodyBuf = req.method === "POST" ? await readBody(req) : Buffer.alloc(0);
    await handleMcp(req, res, bodyBuf);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    try {
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    } catch (e2) {}
  }
}

function listenOn(host) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.on("error", (e) => {
      console.log("[worker] listener on " + host + ":" + PORT + " failed: " + (e.code || e.message));
      resolve(null);
    });
    s.listen(PORT, host, () => resolve([host, PORT, s]));
  });
}

const boundIps = new Set();

async function bindIp(ip) {
  boundIps.add(ip);
  const r = await listenOn(ip);
  if (r) {
    console.log("[worker] listening on " + r[0] + ":" + r[1]);
  } else {
    boundIps.delete(ip);
  }
}

async function watchTailscale() {
  for (;;) {
    try {
      const r = await exec("tailscale", ["ip", "-4"], 10000);
      if (r.ok) {
        const ips = r.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => /^100\.\d+\.\d+\.\d+$/.test(s));
        for (const ip of ips) {
          if (!boundIps.has(ip)) await bindIp(ip);
        }
      }
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

async function main() {
  await jobman.recoverOnBoot();
  jobman.pumpQueue();

  await bindIp("127.0.0.1");

  const staticTsIp = process.env.GPU_WORKER_TS_IP || null;
  if (staticTsIp && /^100\.\d+\.\d+\.\d+$/.test(staticTsIp) && !boundIps.has(staticTsIp)) {
    await bindIp(staticTsIp);
  }

  console.log("[worker] started pid=" + process.pid);
  watchTailscale();

  setInterval(() => {
    console.log("[worker] heartbeat pid=" + process.pid + " uptime=" + Math.round(process.uptime()) + "s");
  }, 5 * 60 * 1000).unref();
}

process.on("uncaughtException", (e) => console.error("[worker] uncaught:", e.message));
process.on("unhandledRejection", (e) => console.error("[worker] unhandled rejection:", String(e)));

main().catch((e) => {
  console.error("[worker] fatal:", e.message);
  process.exit(1);
});
