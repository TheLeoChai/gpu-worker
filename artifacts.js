"use strict";

// Read-only artifact retrieval (LEO-184).
//
// Two scopes are addressable:
//   job  <jobId>  -> the job's workspace under GPU_WORKER_WORKSPACES
//   root <name>   -> an allowlisted persistent checkout (GPU_WORKER_ARTIFACT_ROOTS)
//
// Everything here opens files with O_RDONLY and never creates, moves, hashes in
// place, or otherwise touches the source tree: sealed receipts must stay
// byte-identical after any number of reads or interrupted transfers.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const jobman = require("./jobs.js");

const DEFAULT_ROOTS = "ai-society=F:\\Github\\AI-society";
const MAX_ENTRIES_DEFAULT = 2000;
const MAX_ENTRIES_HARD = 20000;
const CHUNK_DEFAULT = 64 * 1024;
const CHUNK_MAX = 1024 * 1024;
const HASH_BUDGET_BYTES = Math.max(1, parseFloat(process.env.GPU_WORKER_ARTIFACT_HASH_MAX_GB || "8")) * 1024 ** 3;
const JOB_ID_RE = /^[0-9a-fA-F-]{36}$/;
const ROOT_NAME_RE = /^[A-Za-z0-9._-]+$/;

class ArtifactError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badRequest = (m) => new ArtifactError(400, m);
const notFound = (m) => new ArtifactError(404, m);

function parseRoots(spec) {
  const roots = new Map();
  for (const entry of String(spec || "").split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const dir = trimmed.slice(eq + 1).trim();
    if (!ROOT_NAME_RE.test(name) || !dir) continue;
    roots.set(name, path.resolve(dir));
  }
  return roots;
}

const ROOTS = parseRoots(process.env.GPU_WORKER_ARTIFACT_ROOTS || DEFAULT_ROOTS);

function listRoots() {
  return [...ROOTS.entries()].map(([name, dir]) => ({
    name,
    path: dir,
    exists: fs.existsSync(dir),
  }));
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return null;
  }
}

function contains(baseReal, targetReal) {
  const rel = path.relative(baseReal, targetReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Resolve { jobId } or { root } to a base directory. Exactly one is required.
function resolveScope({ jobId, root }) {
  if ((jobId && root) || (!jobId && !root)) throw badRequest("pass exactly one of jobId or root");
  if (jobId) {
    if (!JOB_ID_RE.test(jobId)) throw badRequest("malformed jobId");
    const base = path.join(jobman.WORKSPACES, jobId);
    if (!fs.existsSync(base)) {
      const known = jobman.getJob(jobId);
      throw notFound(
        known
          ? "workspace for job " + jobId + " is no longer on disk (status=" + known.status +
            "; retention keeps the newest " + jobman.KEEP_WORKSPACES + " completed workspaces)"
          : "unknown jobId " + jobId
      );
    }
    return { scope: "job", name: jobId, base };
  }
  if (!ROOT_NAME_RE.test(root)) throw badRequest("malformed root name");
  const base = ROOTS.get(root);
  if (!base) {
    throw notFound(
      "root '" + root + "' is not allowlisted (allowed: " +
        ([...ROOTS.keys()].join(", ") || "none") + "; set GPU_WORKER_ARTIFACT_ROOTS)"
    );
  }
  if (!fs.existsSync(base)) throw notFound("root '" + root + "' is allowlisted but missing on disk: " + base);
  return { scope: "root", name: root, base };
}

// Join a caller-supplied relative path onto a base, refusing anything that
// could escape it (absolute paths, drive letters, UNC, "..", symlinks).
function safeResolve(base, rel) {
  const raw = rel == null ? "" : String(rel);
  if (raw.includes("\0")) throw badRequest("path contains a NUL byte");
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || /^[\\/]{2}/.test(raw)) {
    throw badRequest("path must be relative to the artifact root");
  }
  const parts = raw.split(/[\\/]+/).filter((s) => s.length && s !== ".");
  if (parts.some((p) => p === "..")) throw badRequest("path traversal rejected");

  const baseReal = realpath(base);
  if (!baseReal) throw notFound("artifact base does not exist: " + base);
  const abs = path.resolve(baseReal, ...parts);
  if (!contains(baseReal, abs)) throw badRequest("path traversal rejected");

  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (e) {
    throw notFound("no such artifact: " + (parts.join("/") || "."));
  }
  if (st.isSymbolicLink()) throw badRequest("refusing to follow symlink: " + parts.join("/"));
  const absReal = realpath(abs);
  if (!absReal || !contains(baseReal, absReal)) throw badRequest("path traversal rejected");
  return { abs: absReal, rel: parts.join("/"), stat: fs.statSync(absReal) };
}

function etagFor(st) {
  return '"' + st.size.toString(16) + "-" + Math.floor(st.mtimeMs).toString(16) + '"';
}

function sha256File(abs) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

// Depth-first file list, sorted, symlinks and specials skipped (reported).
function walk(abs, relPrefix, limit, out, skipped) {
  const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of entries) {
    if (out.length >= limit) return true;
    const childAbs = path.join(abs, d.name);
    const childRel = relPrefix ? relPrefix + "/" + d.name : d.name;
    if (d.isSymbolicLink()) {
      skipped.push({ path: childRel, reason: "symlink" });
      continue;
    }
    if (d.isDirectory()) {
      if (walk(childAbs, childRel, limit, out, skipped)) return true;
      continue;
    }
    if (!d.isFile()) {
      skipped.push({ path: childRel, reason: "not a regular file" });
      continue;
    }
    let st;
    try {
      st = fs.statSync(childAbs);
    } catch (e) {
      skipped.push({ path: childRel, reason: "unreadable" });
      continue;
    }
    out.push({ path: childRel, abs: childAbs, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), etag: etagFor(st) });
  }
  return false;
}

// Manifest for a file or whole directory: immutable per-file sha256 + size, so
// a copy can be verified byte-for-byte on the receiving host.
function manifest(target, opts) {
  const options = opts || {};
  const hashes = options.hashes !== false;
  let limit = options.maxEntries > 0 ? Math.floor(options.maxEntries) : MAX_ENTRIES_DEFAULT;
  limit = Math.min(limit, MAX_ENTRIES_HARD);

  const files = [];
  const skipped = [];
  let truncated = false;
  if (target.stat.isDirectory()) {
    truncated = walk(target.abs, "", limit, files, skipped);
  } else if (target.stat.isFile()) {
    files.push({
      path: target.rel.split("/").pop() || target.rel,
      abs: target.abs,
      bytes: target.stat.size,
      mtime: new Date(target.stat.mtimeMs).toISOString(),
      etag: etagFor(target.stat),
    });
  } else {
    throw badRequest("not a file or directory: " + target.rel);
  }

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  if (hashes && totalBytes > HASH_BUDGET_BYTES) {
    throw badRequest(
      "refusing to hash " + (totalBytes / 1024 ** 3).toFixed(1) + " GB (limit " +
        (HASH_BUDGET_BYTES / 1024 ** 3).toFixed(1) + " GB): narrow the path or pass hashes=false"
    );
  }
  for (const f of files) {
    if (hashes) f.sha256 = sha256File(f.abs);
    delete f.abs;
  }
  return {
    kind: target.stat.isDirectory() ? "directory" : "file",
    path: target.rel,
    fileCount: files.length,
    totalBytes,
    truncated,
    maxEntries: limit,
    hashAlgorithm: hashes ? "sha256" : null,
    files,
    skipped,
  };
}

// Single bounded read. offset/length make an interrupted pull resumable
// without ever rewriting the source file.
function readChunk(target, offset, length) {
  if (!target.stat.isFile()) throw badRequest("not a regular file: " + target.rel);
  const size = target.stat.size;
  const start = offset > 0 ? Math.floor(offset) : 0;
  if (start > size) throw badRequest("offset " + start + " is past end of file (" + size + " bytes)");
  let want = length > 0 ? Math.floor(length) : CHUNK_DEFAULT;
  if (want > CHUNK_MAX) {
    throw badRequest(
      "length " + want + " exceeds the " + CHUNK_MAX + "-byte chunk limit; use the /artifact HTTP endpoint " +
        "(supports Range + resume) for bulk copies"
    );
  }
  want = Math.min(want, size - start);
  const buf = Buffer.allocUnsafe(Math.max(0, want));
  let read = 0;
  const fd = fs.openSync(target.abs, "r");
  try {
    while (read < want) {
      const n = fs.readSync(fd, buf, read, want - read, start + read);
      if (n <= 0) break;
      read += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  const data = buf.subarray(0, read);
  return {
    offset: start,
    length: read,
    eof: start + read >= size,
    bytes: size,
    etag: etagFor(target.stat),
    chunkSha256: crypto.createHash("sha256").update(data).digest("hex"),
    data,
  };
}

// "bytes=start-end" (single range only). Returns null when absent, false when
// unsatisfiable, else { start, end }.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return false;
  const [, s, e] = m;
  if (s === "" && e === "") return false;
  let start;
  let end;
  if (s === "") {
    const suffix = parseInt(e, 10);
    if (!suffix) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(s, 10);
    end = e === "" ? size - 1 : parseInt(e, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return false;
  return { start, end: Math.min(end, size - 1) };
}

function urlFor(host, scope, name, rel) {
  const segments = String(rel || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent);
  return "http://" + host + "/artifact/" + scope + "/" + encodeURIComponent(name) + (segments.length ? "/" + segments.join("/") : "");
}

module.exports = {
  ArtifactError,
  badRequest,
  notFound,
  listRoots,
  resolveScope,
  safeResolve,
  manifest,
  readChunk,
  parseRange,
  etagFor,
  sha256File,
  urlFor,
  CHUNK_DEFAULT,
  CHUNK_MAX,
  MAX_ENTRIES_DEFAULT,
};
