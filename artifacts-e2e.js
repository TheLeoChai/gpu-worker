"use strict";

// Self-contained end-to-end test for read-only artifact retrieval (LEO-184).
//
// Spawns this checkout's server.js on a spare loopback port with temporary
// workspaces/roots/tokens, then drives the MCP tools, the /artifact HTTP
// endpoint and tools/fetch-artifacts.mjs against it. It submits no jobs, so it
// is safe to run from inside a worker job (the queue is FIFO, one at a time).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const ROOT = __dirname;
const PORT = parseInt(process.env.ARTIFACT_TEST_PORT || "4199", 10);
const BASE = "http://127.0.0.1:" + PORT;
const TOKEN = crypto.randomUUID();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-artifacts-e2e-"));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failures.push(name + (detail ? " -> " + detail : ""));
    console.log("  FAIL " + name + (detail ? " -> " + detail : ""));
  }
}
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixture -----------------------------------------------------------------
const src = path.join(tmp, "receipts");
const ws = path.join(tmp, "workspaces");
const fixture = {
  "seal.json": Buffer.from('{"sealed":true,"cases":32}\n'),
  "pilot_report.json": Buffer.from('{"status":"BLOCKED","canary":"dose_0p05"}\n'),
  "cases/case_001.json": Buffer.from('{"case":1,"text":"canary raw text"}\n'),
  "cases/big.bin": crypto.randomBytes(300 * 1024),
};
fs.mkdirSync(path.join(src, "cases"), { recursive: true });
for (const [rel, buf] of Object.entries(fixture)) fs.writeFileSync(path.join(src, rel), buf);
fs.writeFileSync(path.join(tmp, "secret.txt"), "must never be served\n");
const jobId = crypto.randomUUID();
fs.mkdirSync(path.join(ws, jobId), { recursive: true });
fs.writeFileSync(path.join(ws, jobId, "job.log"), "job output\n");
fs.writeFileSync(path.join(tmp, "auth.env"), "GPU_WORKER_TOKEN=" + TOKEN + "\n");

function fixtureState() {
  return Object.keys(fixture)
    .sort()
    .map((rel) => {
      const st = fs.statSync(path.join(src, rel));
      return rel + ":" + st.size + ":" + Math.floor(st.mtimeMs) + ":" + sha256(fs.readFileSync(path.join(src, rel)));
    })
    .join("\n");
}
const stateBefore = fixtureState();

async function http(urlPath, opts) {
  const options = opts || {};
  const headers = Object.assign({}, options.headers || {});
  if (options.token !== null) headers.Authorization = "Bearer " + (options.token || TOKEN);
  const res = await fetch(BASE + urlPath, { method: options.method || "GET", headers });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

function runNode(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), encoding: "utf8", timeout: 120000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "" }));
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      GPU_WORKER_PORT: String(PORT),
      GPU_WORKER_AUTH: path.join(tmp, "auth.env"),
      GPU_WORKER_WORKSPACES: ws,
      GPU_WORKER_JOBS_FILE: path.join(tmp, "jobs.json"),
      GPU_WORKER_LOGS_DIR: path.join(tmp, "logs"),
      GPU_WORKER_ARTIFACT_ROOTS: "receipts=" + src,
      GPU_WORKER_ALLOWED_IPS: "127.0.0.1",
      GPU_WORKER_KEEP_WORKSPACES: "3",
      GPU_WORKER_MIN_FREE_GB: "0",
    }),
  });
  let serverOut = "";
  server.stdout.on("data", (d) => (serverOut += d.toString()));
  server.stderr.on("data", (d) => (serverOut += d.toString()));

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(500);
      try {
        const r = await fetch(BASE + "/health");
        up = r.status === 200;
      } catch (e) {}
    }
    if (!up) throw new Error("test server did not come up on " + BASE + "\n" + serverOut);

    const client = new Client({ name: "artifacts-e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + TOKEN } } })
    );
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content || []).map((c) => c.text || "").join("");
      return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
    };

    console.log("\n[tools registered]");
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check("list_job_artifacts is exposed", tools.includes("list_job_artifacts"), tools.join(","));
    check("get_job_artifact is exposed", tools.includes("get_job_artifact"), tools.join(","));
    const hostInfo = await call("host_info", {});
    check(
      "host_info reports the allowlisted root",
      hostInfo.json.artifactRoots.some((r) => r.name === "receipts" && r.exists),
      JSON.stringify(hostInfo.json.artifactRoots)
    );

    console.log("\n[manifest]");
    const man = await call("list_job_artifacts", { root: "receipts" });
    check("manifest lists every file", man.json.fileCount === 4, JSON.stringify(man.json.files && man.json.files.map((f) => f.path)));
    check("manifest totals the bytes", man.json.totalBytes === Object.values(fixture).reduce((n, b) => n + b.length, 0), String(man.json.totalBytes));
    const byPath = Object.fromEntries((man.json.files || []).map((f) => [f.path, f]));
    check(
      "manifest sha256 matches the source bytes",
      Object.entries(fixture).every(([rel, buf]) => byPath[rel] && byPath[rel].sha256 === sha256(buf)),
      JSON.stringify(byPath["seal.json"])
    );
    check("manifest carries a download URL per file", (man.json.files || []).every((f) => /\/artifact\/root\/receipts\//.test(f.url)), byPath["seal.json"] && byPath["seal.json"].url);
    const narrowed = await call("list_job_artifacts", { root: "receipts", path: "cases" });
    check("manifest narrows to a subdirectory", narrowed.json.fileCount === 2 && narrowed.json.files.every((f) => !f.path.includes("/")), JSON.stringify(narrowed.json.files.map((f) => f.path)));
    const single = await call("list_job_artifacts", { root: "receipts", path: "seal.json" });
    check("manifest of a single file", single.json.kind === "file" && single.json.files[0].sha256 === sha256(fixture["seal.json"]), single.text.slice(0, 200));
    const noHash = await call("list_job_artifacts", { root: "receipts", hashes: false });
    check("hashes=false skips hashing", noHash.json.hashAlgorithm === null && !noHash.json.files[0].sha256, noHash.text.slice(0, 160));
    const jobMan = await call("list_job_artifacts", { jobId });
    check("job scope reads the workspace", jobMan.json.fileCount === 1 && jobMan.json.files[0].path === "job.log", jobMan.text.slice(0, 200));

    console.log("\n[rejections]");
    for (const [name, args] of [
      ["parent traversal", { root: "receipts", path: "../secret.txt" }],
      ["windows traversal", { root: "receipts", path: "..\\secret.txt" }],
      ["nested traversal", { root: "receipts", path: "cases/../../secret.txt" }],
      ["posix absolute path", { root: "receipts", path: "/etc/passwd" }],
      ["windows absolute path", { root: "receipts", path: "C:\\Windows\\win.ini" }],
      ["UNC path", { root: "receipts", path: "\\\\server\\share\\x" }],
      ["unknown root", { root: "not-allowlisted", path: "x" }],
      ["malformed jobId", { jobId: "../../etc" }],
      ["both scopes at once", { root: "receipts", jobId: jobId }],
      ["no scope", { path: "seal.json" }],
      ["missing artifact", { root: "receipts", path: "cases/absent.json" }],
    ]) {
      const r = await call("list_job_artifacts", args);
      check("list rejects " + name, r.isError, r.text.slice(0, 120));
    }
    const symlink = path.join(src, "escape-link");
    let symlinkMade = false;
    try {
      fs.symlinkSync(path.join(tmp, "secret.txt"), symlink);
      symlinkMade = true;
    } catch (e) {
      console.log("  skip symlink case (" + ((e && e.code) || e) + ")");
    }
    if (symlinkMade) {
      const r = await call("get_job_artifact", { root: "receipts", path: "escape-link" });
      check("get refuses to follow a symlink", r.isError, r.text.slice(0, 160));
      const withLink = await call("list_job_artifacts", { root: "receipts" });
      check(
        "manifest skips symlinks instead of following them",
        withLink.json.fileCount === 4 && withLink.json.skipped.some((s) => s.path === "escape-link"),
        withLink.text.slice(0, 200)
      );
      fs.unlinkSync(symlink);
    }

    console.log("\n[chunked reads]");
    const head = await call("get_job_artifact", { root: "receipts", path: "cases/big.bin", offset: 0, length: 1024 });
    check("chunk returns its own sha256 and file size", head.json.bytes === fixture["cases/big.bin"].length && head.json.length === 1024 && head.json.chunkSha256 === sha256(fixture["cases/big.bin"].subarray(0, 1024)), head.text.slice(0, 200));
    check("chunk bytes are exact", Buffer.from(head.json.data, "base64").equals(fixture["cases/big.bin"].subarray(0, 1024)));
    check("chunk is not eof mid-file", head.json.eof === false, String(head.json.eof));
    const resumeChunk = await call("get_job_artifact", { root: "receipts", path: "cases/big.bin", offset: fixture["cases/big.bin"].length - 10, length: 1024 });
    check("chunk resumes from an offset and flags eof", resumeChunk.json.eof === true && Buffer.from(resumeChunk.json.data, "base64").equals(fixture["cases/big.bin"].subarray(-10)), resumeChunk.text.slice(0, 200));
    const text = await call("get_job_artifact", { root: "receipts", path: "pilot_report.json", encoding: "utf8" });
    check("utf8 chunk returns readable text", text.json.data === fixture["pilot_report.json"].toString("utf8"), JSON.stringify(text.json.data));
    const tooBig = await call("get_job_artifact", { root: "receipts", path: "cases/big.bin", length: 8 * 1024 * 1024 });
    check("chunk length over the cap is rejected", tooBig.isError, tooBig.text.slice(0, 160));
    const pastEnd = await call("get_job_artifact", { root: "receipts", path: "seal.json", offset: 10 ** 6 });
    check("offset past end is rejected", pastEnd.isError, pastEnd.text.slice(0, 160));
    const dirChunk = await call("get_job_artifact", { root: "receipts", path: "cases" });
    check("get on a directory is rejected", dirChunk.isError, dirChunk.text.slice(0, 160));
    await client.close();

    console.log("\n[http endpoint]");
    const unauth = await http("/artifact/root/receipts/seal.json", { token: null });
    check("no token -> 401", unauth.status === 401, String(unauth.status));
    const wrongToken = await http("/artifact/root/receipts/seal.json", { token: "not-the-token" });
    check("wrong token -> 401", wrongToken.status === 401, String(wrongToken.status));
    const full = await http("/artifact/root/receipts/cases/big.bin?sha256=1");
    check("full download byte-for-byte", full.status === 200 && full.body.equals(fixture["cases/big.bin"]), String(full.status) + " " + full.body.length);
    check("X-Artifact-SHA256 matches", full.headers.get("x-artifact-sha256") === sha256(fixture["cases/big.bin"]), full.headers.get("x-artifact-sha256"));
    check("Accept-Ranges advertised", full.headers.get("accept-ranges") === "bytes", full.headers.get("accept-ranges"));
    const etag = full.headers.get("etag");
    const part1 = await http("/artifact/root/receipts/cases/big.bin", { headers: { Range: "bytes=0-99" } });
    const part2 = await http("/artifact/root/receipts/cases/big.bin", { headers: { Range: "bytes=100-" } });
    check("ranged reads are 206", part1.status === 206 && part2.status === 206, part1.status + "/" + part2.status);
    check("Content-Range is correct", part1.headers.get("content-range") === "bytes 0-99/" + fixture["cases/big.bin"].length, part1.headers.get("content-range"));
    check("ranges reassemble to the original", Buffer.concat([part1.body, part2.body]).equals(fixture["cases/big.bin"]), String(Buffer.concat([part1.body, part2.body]).length));
    const suffix = await http("/artifact/root/receipts/cases/big.bin", { headers: { Range: "bytes=-16" } });
    check("suffix range works", suffix.status === 206 && suffix.body.equals(fixture["cases/big.bin"].subarray(-16)));
    const badRange = await http("/artifact/root/receipts/seal.json", { headers: { Range: "bytes=99999-" } });
    check("unsatisfiable range -> 416", badRange.status === 416 && badRange.headers.get("content-range") === "bytes */" + fixture["seal.json"].length, String(badRange.status));
    const stale = await http("/artifact/root/receipts/seal.json", { headers: { "If-Match": '"deadbeef-1"', Range: "bytes=1-" } });
    check("stale If-Match -> 412 (resume rejected, not spliced)", stale.status === 412, String(stale.status));
    const fresh = await http("/artifact/root/receipts/seal.json", { headers: { "If-Match": etag === null ? "*" : (await http("/artifact/root/receipts/seal.json", { method: "HEAD" })).headers.get("etag") } });
    check("matching If-Match is served", fresh.status === 200 && fresh.body.equals(fixture["seal.json"]), String(fresh.status));
    const headReq = await http("/artifact/root/receipts/seal.json", { method: "HEAD" });
    check("HEAD reports size without a body", headReq.status === 200 && headReq.body.length === 0 && headReq.headers.get("content-length") === String(fixture["seal.json"].length), String(headReq.status));
    const dirGet = await http("/artifact/root/receipts/cases");
    check("directory without ?manifest -> 400", dirGet.status === 400, String(dirGet.status));
    const httpManifest = await http("/artifact/root/receipts?manifest=1");
    const hm = JSON.parse(httpManifest.body.toString("utf8"));
    check("HTTP manifest carries sha256", hm.fileCount === 4 && hm.files.every((f) => f.sha256), httpManifest.body.toString("utf8").slice(0, 160));
    const missing = await http("/artifact/root/receipts/cases/absent.json");
    check("missing artifact -> 404", missing.status === 404, String(missing.status));
    const travHttp = await http("/artifact/root/receipts/..%2Fsecret.txt");
    check("encoded traversal over HTTP is rejected", travHttp.status === 400 || travHttp.status === 404, String(travHttp.status));
    const badScope = await http("/artifact/nope/receipts/seal.json");
    check("unknown scope kind -> 400", badScope.status === 400, String(badScope.status));
    const post = await http("/artifact/root/receipts/seal.json", { method: "POST" });
    check("writes are refused (405)", post.status === 405, String(post.status));

    console.log("\n[copy-only fetch tool]");
    const out = path.join(tmp, "copy");
    const fetched = await runNode([path.join(ROOT, "tools", "fetch-artifacts.mjs"), "--host", BASE, "--root", "receipts", "--out", out, "--quiet"], { GPU_WORKER_TOKEN: TOKEN });
    check("fetch-artifacts reports FETCH_OK", fetched.ok && /FETCH_OK files=4/.test(fetched.stdout), (fetched.stdout + fetched.stderr).slice(-300));
    check(
      "every copied file is byte-identical",
      Object.entries(fixture).every(([rel, buf]) => {
        try {
          return fs.readFileSync(path.join(out, rel.split("/").join(path.sep))).equals(buf);
        } catch (e) {
          return false;
        }
      })
    );
    check("manifest is written beside the copy", fs.existsSync(out + ".manifest.json"));
    check("no .part files are left behind", !fs.readdirSync(path.join(out, "cases")).some((f) => f.endsWith(".part")));
    const again = await runNode([path.join(ROOT, "tools", "fetch-artifacts.mjs"), "--host", BASE, "--root", "receipts", "--out", out, "--quiet"], { GPU_WORKER_TOKEN: TOKEN });
    check("re-running copies nothing new", again.ok && /copied=0/.test(again.stdout), again.stdout.slice(-200));

    // interrupted transfer: a valid partial resumes from where it stopped
    const resumeOut = path.join(tmp, "resume");
    fs.mkdirSync(path.join(resumeOut, "cases"), { recursive: true });
    const bigEtag = (await http("/artifact/root/receipts/cases/big.bin", { method: "HEAD" })).headers.get("etag");
    const partPath = path.join(resumeOut, "cases", "big.bin.part");
    fs.writeFileSync(partPath, fixture["cases/big.bin"].subarray(0, 4096));
    fs.writeFileSync(partPath + ".etag", bigEtag);
    const resumed = await runNode([path.join(ROOT, "tools", "fetch-artifacts.mjs"), "--host", BASE, "--root", "receipts", "--out", resumeOut], { GPU_WORKER_TOKEN: TOKEN });
    check("interrupted transfer resumes", resumed.ok && /FETCH_OK/.test(resumed.stdout), (resumed.stdout + resumed.stderr).slice(-300));
    check("resumed file is byte-identical", fs.readFileSync(path.join(resumeOut, "cases", "big.bin")).equals(fixture["cases/big.bin"]));
    check("resume actually reused the partial", /copied=/.test(resumed.stdout) && Number((resumed.stdout.match(/copied=(\d+)/) || [])[1]) < fixture["cases/big.bin"].length, resumed.stdout.slice(-200));

    // a partial from a different version of the file is discarded, not spliced
    const staleOut = path.join(tmp, "stale");
    fs.mkdirSync(path.join(staleOut, "cases"), { recursive: true });
    const stalePart = path.join(staleOut, "cases", "big.bin.part");
    fs.writeFileSync(stalePart, Buffer.alloc(4096, 0x41));
    fs.writeFileSync(stalePart + ".etag", '"beef-1"');
    const restarted = await runNode([path.join(ROOT, "tools", "fetch-artifacts.mjs"), "--host", BASE, "--root", "receipts", "--out", staleOut], { GPU_WORKER_TOKEN: TOKEN });
    check("stale partial is rejected and restarted", restarted.ok && /partial rejected/.test(restarted.stdout), (restarted.stdout + restarted.stderr).slice(-300));
    check("restarted file is byte-identical", fs.readFileSync(path.join(staleOut, "cases", "big.bin")).equals(fixture["cases/big.bin"]));
    const noToken = await runNode([path.join(ROOT, "tools", "fetch-artifacts.mjs"), "--host", BASE, "--root", "receipts", "--out", path.join(tmp, "denied")], { GPU_WORKER_TOKEN: "" });
    check("fetch without a token fails closed", !noToken.ok && /FETCH_FAILED/.test(noToken.stdout + noToken.stderr), (noToken.stdout + noToken.stderr).slice(-200));

    console.log("\n[source is untouched]");
    check("source sizes/mtimes/hashes unchanged", fixtureState() === stateBefore);
    check("no new files in the source tree", fs.readdirSync(src).sort().join(",") === "cases,pilot_report.json,seal.json", fs.readdirSync(src).join(","));
  } finally {
    server.kill();
    await sleep(300);
    try {
      await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {}
  }

  console.log("\n" + passed + " checks passed, " + failures.length + " failed");
  if (failures.length) {
    for (const f of failures) console.log("FAILED: " + f);
    process.exit(1);
  }
  console.log("ARTIFACTS_E2E_OK");
}

main().catch((e) => {
  console.error("ARTIFACTS_E2E_ERROR: " + ((e && e.stack) || e));
  process.exit(1);
});
