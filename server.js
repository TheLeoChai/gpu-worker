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
const artifacts = require("./artifacts.js");

const ROOT = __dirname;
const PORT = parseInt(process.env.GPU_WORKER_PORT || "4120", 10);

// auth.env holds the owner token (GPU_WORKER_TOKEN) and, optionally, a
// restricted token for delegated subagents (GPU_WORKER_AGENT_TOKEN, LEO-176).
function loadTokens() {
  const envPath = process.env.GPU_WORKER_AUTH || path.join(ROOT, "auth.env");
  const text = fs.readFileSync(envPath, "utf8");
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(GPU_WORKER_TOKEN|GPU_WORKER_AGENT_TOKEN)\s*=\s*(\S+)\s*$/);
    if (m) found[m[1]] = m[2];
  }
  if (!found.GPU_WORKER_TOKEN) throw new Error("GPU_WORKER_TOKEN not found in " + envPath);
  const tokens = [{ role: "owner", buf: Buffer.from(found.GPU_WORKER_TOKEN, "utf8") }];
  if (found.GPU_WORKER_AGENT_TOKEN && found.GPU_WORKER_AGENT_TOKEN !== found.GPU_WORKER_TOKEN) {
    tokens.push({ role: "agent", buf: Buffer.from(found.GPU_WORKER_AGENT_TOKEN, "utf8") });
  }
  return tokens;
}
const TOKENS = loadTokens();

// Commands the agent role may never submit.
const AGENT_DENIED_COMMANDS = [/cleanup_persistent_results/i];

let allowedIps = null;
if (process.env.GPU_WORKER_ALLOWED_IPS) {
  allowedIps = new Set(
    process.env.GPU_WORKER_ALLOWED_IPS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// Returns the caller's role ("owner" | "agent"), or null when unauthorized.
function checkAuth(req) {
  if (allowedIps && !allowedIps.has(req.socket.remoteAddress || "")) return null;
  const h = req.headers.authorization || "";
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const got = Buffer.from(h.slice(7), "utf8");
  for (const t of TOKENS) {
    if (got.length === t.buf.length && crypto.timingSafeEqual(got, t.buf)) return t.role;
  }
  return null;
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

function registerTools(server, role, host) {
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
        artifactRoots: artifacts.listRoots(),
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
      if (role === "agent" && AGENT_DENIED_COMMANDS.some((re) => re.test(command))) {
        return { isError: true, content: [{ type: "text", text: "command not allowed for agent token" }] };
      }
      const j = jobman.enqueue(repo, ref, command, timeout_minutes, role);
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
        checkoutDrift: j.checkoutDrift || null,
        submittedBy: j.submittedBy || "owner",
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
      description:
        "Cancel a queued or running job (kills the process tree of a running job). With the agent token, only queued jobs submitted with the agent token can be cancelled.",
      inputSchema: { jobId: z.string().describe("jobId returned by run_job") },
    },
    async ({ jobId }) => {
      if (role === "agent") {
        const j = jobman.getJob(jobId);
        if (j && (j.submittedBy !== "agent" || j.status !== "queued")) {
          return jsonText({ ok: false, error: "agent token may only cancel queued jobs it submitted (status=" + j.status + ")" });
        }
      }
      const res = await jobman.cancelJob(jobId);
      return jsonText(res.ok ? res : { ok: false, error: res.error });
    }
  );

  // Read-only artifact retrieval (LEO-184). Bytes never leave through an LLM
  // response unless the caller explicitly asks for a chunk: the manifest hands
  // back authenticated /artifact URLs that resume with HTTP Range.
  server.registerTool(
    "list_job_artifacts",
    {
      title: "List Job Artifacts",
      description:
        "Read-only manifest of a job workspace or an allowlisted persistent checkout on the GPU PC: every file with size, mtime and sha256, plus an authenticated download URL per file. Pass exactly one of jobId (its retained workspace) or root (an allowlisted path, see artifactRoots in host_info) and an optional relative path to narrow to a subdirectory or single file. Nothing is created, modified or committed; symlinks, absolute paths and '..' are rejected. Use the returned downloadBase/URLs (HTTP Range, resumable) or tools/fetch-artifacts.mjs for bulk copies, and get_job_artifact for small chunks.",
      inputSchema: {
        jobId: z.string().optional().describe("jobId whose workspace to read (mutually exclusive with root)"),
        root: z.string().optional().describe("Allowlisted artifact root name (see host_info.artifactRoots)"),
        path: z.string().optional().describe("Relative path inside the scope (default: whole scope)"),
        hashes: z.boolean().optional().describe("Compute sha256 per file (default true)"),
        maxEntries: z.number().optional().describe("Max files to list (default 2000, hard cap 20000)"),
      },
    },
    async ({ jobId, root, path: relPath, hashes, maxEntries }) => {
      try {
        const scope = artifacts.resolveScope({ jobId, root });
        const target = artifacts.safeResolve(scope.base, relPath);
        const man = artifacts.manifest(target, { hashes, maxEntries });
        const downloadBase = artifacts.urlFor(host, scope.scope, scope.name, man.path);
        return jsonText({
          scope: scope.scope,
          name: scope.name,
          base: scope.base,
          sourcePath: path.join(scope.base, man.path.split("/").join(path.sep)),
          kind: man.kind,
          path: man.path,
          fileCount: man.fileCount,
          totalBytes: man.totalBytes,
          truncated: man.truncated,
          maxEntries: man.maxEntries,
          hashAlgorithm: man.hashAlgorithm,
          downloadBase,
          manifestUrl: downloadBase + "?manifest=1",
          fetchCommand:
            'GPU_WORKER_TOKEN=<token> node tools/fetch-artifacts.mjs --url "' + downloadBase + '" --out <dir>',
          files: man.files.map((f) => Object.assign({}, f, {
            url: artifacts.urlFor(host, scope.scope, scope.name, man.kind === "file" ? man.path : man.path ? man.path + "/" + f.path : f.path),
          })),
          skipped: man.skipped,
        });
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String((e && e.message) || e) }] };
      }
    }
  );

  server.registerTool(
    "get_job_artifact",
    {
      title: "Get Job Artifact",
      description:
        "Read one bounded chunk of a single artifact file, read-only. Pass exactly one of jobId or root plus the relative path; offset/length make an interrupted read resumable (default 64 KiB, max 1 MiB per call). Returns the full file size, its etag, the chunk's own sha256 and the bytes (base64, or utf8 text on request). For whole directories or large files prefer the /artifact download URLs from list_job_artifacts.",
      inputSchema: {
        jobId: z.string().optional().describe("jobId whose workspace to read (mutually exclusive with root)"),
        root: z.string().optional().describe("Allowlisted artifact root name (see host_info.artifactRoots)"),
        path: z.string().describe("Relative path of the file inside the scope"),
        offset: z.number().optional().describe("Byte offset to start at (default 0)"),
        length: z.number().optional().describe("Bytes to read (default 65536, max 1048576)"),
        encoding: z.enum(["base64", "utf8"]).optional().describe("Chunk encoding (default base64)"),
      },
    },
    async ({ jobId, root, path: relPath, offset, length, encoding }) => {
      try {
        const scope = artifacts.resolveScope({ jobId, root });
        const target = artifacts.safeResolve(scope.base, relPath);
        const chunk = artifacts.readChunk(target, offset, length);
        const enc = encoding === "utf8" ? "utf8" : "base64";
        return jsonText({
          scope: scope.scope,
          name: scope.name,
          path: target.rel,
          sourcePath: target.abs,
          bytes: chunk.bytes,
          etag: chunk.etag,
          offset: chunk.offset,
          length: chunk.length,
          eof: chunk.eof,
          encoding: enc,
          chunkSha256: chunk.chunkSha256,
          downloadUrl: artifacts.urlFor(host, scope.scope, scope.name, target.rel),
          data: chunk.data.toString(enc),
        });
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String((e && e.message) || e) }] };
      }
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

// GET/HEAD /artifact/<job|root>/<name>/<relative/path>
//   ?manifest=1[&hashes=0]  -> JSON manifest (sha256 + size per file)
//   otherwise               -> the file's bytes, read-only, Range-resumable.
// Callers resuming a partial copy should send If-Match with the etag they
// started from: a changed file answers 412 instead of splicing mismatched bytes.
async function handleArtifact(req, res, rawUrl) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  const u = new URL(rawUrl, "http://localhost");
  let segments;
  try {
    segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "malformed percent-encoding in path" }));
    return;
  }
  try {
    const kind = segments[1];
    const name = segments[2];
    const rel = segments.slice(3).join("/");
    if (!name || (kind !== "job" && kind !== "root")) {
      throw artifacts.badRequest("expected /artifact/job/<jobId>/<path> or /artifact/root/<name>/<path>");
    }
    const scope = artifacts.resolveScope(kind === "job" ? { jobId: name } : { root: name });
    const target = artifacts.safeResolve(scope.base, rel);

    if (u.searchParams.get("manifest") === "1") {
      const man = artifacts.manifest(target, { hashes: u.searchParams.get("hashes") !== "0" });
      const body = Buffer.from(JSON.stringify(Object.assign({ scope: scope.scope, name: scope.name, base: scope.base }, man), null, 2));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (target.stat.isDirectory()) {
      throw artifacts.badRequest("that is a directory; add ?manifest=1 for its listing, or request a file inside it");
    }
    if (!target.stat.isFile()) throw artifacts.badRequest("not a regular file: " + target.rel);

    const size = target.stat.size;
    const etag = artifacts.etagFor(target.stat);
    const ifMatch = req.headers["if-match"];
    if (ifMatch && ifMatch !== "*" && !String(ifMatch).split(",").map((s) => s.trim()).includes(etag)) {
      res.writeHead(412, { "Content-Type": "application/json", ETag: etag });
      res.end(JSON.stringify({ error: "artifact changed since etag " + ifMatch + " (now " + etag + "); restart the transfer" }));
      return;
    }
    const range = artifacts.parseRange(req.headers.range, size);
    if (range === false) {
      res.writeHead(416, { "Content-Range": "bytes */" + size, "Content-Type": "application/json", ETag: etag });
      res.end(JSON.stringify({ error: "unsatisfiable range for a " + size + "-byte artifact" }));
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": size === 0 ? 0 : end - start + 1,
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Last-Modified": new Date(target.stat.mtimeMs).toUTCString(),
      "Cache-Control": "no-store",
      "X-Artifact-Path": target.rel,
      "X-Artifact-Bytes": String(size),
    };
    if (u.searchParams.get("sha256") === "1") headers["X-Artifact-SHA256"] = artifacts.sha256File(target.abs);
    if (range) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(target.abs, { start, end, flags: "r" });
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    const status = e instanceof artifacts.ArtifactError ? e.status : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}

async function handleMcp(req, res, bodyBuf, role) {
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
  registerTools(server, role, req.headers.host || "127.0.0.1:" + PORT);
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
  const role = checkAuth(req);
  if (!role) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  try {
    if (url === "/artifact" || url.startsWith("/artifact/") || url.startsWith("/artifact?")) {
      await handleArtifact(req, res, url);
      return;
    }
    const bodyBuf = req.method === "POST" ? await readBody(req) : Buffer.alloc(0);
    await handleMcp(req, res, bodyBuf, role);
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
