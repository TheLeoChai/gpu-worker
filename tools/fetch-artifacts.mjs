#!/usr/bin/env node
// Copy-only artifact fetcher for the desktop GPU worker (LEO-184).
//
// Downloads a job workspace / allowlisted checkout subtree to a local
// directory over the worker's authenticated /artifact endpoint, verifies every
// file against the server manifest's sha256, and resumes interrupted transfers
// with HTTP Range. It never writes to the source host, never commits or pushes,
// and refuses to splice bytes when the source file changed mid-copy.
//
// Usage:
//   GPU_WORKER_TOKEN=<token> node tools/fetch-artifacts.mjs \
//     --url http://<host>:4120/artifact/root/<name>/<path> --out <dir>
//   GPU_WORKER_TOKEN=<token> node tools/fetch-artifacts.mjs \
//     --host http://<host>:4120 --job <jobId> [--path <rel>] --out <dir>
//
// Options: --restart (discard partials), --quiet, --token <t> (else
// GPU_WORKER_TOKEN). Exit 0 = every file copied and hash-verified.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error("unexpected argument: " + a);
    const key = a.slice(2);
    if (key === "restart" || key === "quiet") {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error("missing value for --" + key);
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const token = args.token || process.env.GPU_WORKER_TOKEN;
const log = (...m) => {
  if (!args.quiet) console.log(...m);
};

function fail(msg) {
  console.error("FETCH_FAILED " + msg);
  process.exit(1);
}

if (!token) fail("no token: pass --token or set GPU_WORKER_TOKEN");
if (!args.out) fail("--out <dir> is required");

let baseUrl = args.url;
if (!baseUrl) {
  if (!args.host || (!args.job && !args.root)) fail("pass --url, or --host with --job/--root");
  const scope = args.job ? "job/" + encodeURIComponent(args.job) : "root/" + encodeURIComponent(args.root);
  const rel = (args.path || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  baseUrl = args.host.replace(/\/+$/, "") + "/artifact/" + scope + (rel ? "/" + rel : "");
}
baseUrl = baseUrl.replace(/\/+$/, "");

const auth = { Authorization: "Bearer " + token };

function safeRel(rel) {
  const parts = String(rel).split("/").filter(Boolean);
  if (!parts.length) throw new Error("manifest entry with empty path");
  if (parts.some((p) => p === "." || p === ".." || p.includes("\\") || p.includes("\0"))) {
    throw new Error("manifest entry rejected (unsafe path): " + rel);
  }
  return parts;
}

async function getManifest() {
  const res = await fetch(baseUrl + "?manifest=1", { headers: auth });
  const text = await res.text();
  if (!res.ok) throw new Error("manifest request failed (HTTP " + res.status + "): " + text.slice(0, 400));
  const man = JSON.parse(text);
  if (man.hashAlgorithm !== "sha256") throw new Error("manifest has no sha256 hashes");
  if (man.truncated) throw new Error("manifest truncated (" + man.fileCount + " files); narrow --path");
  return man;
}

function urlForEntry(man, rel) {
  if (man.kind === "file") return baseUrl;
  return baseUrl + "/" + rel.split("/").map(encodeURIComponent).join("/");
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch (e) {
    return -1;
  }
}

async function fetchOne(entry, url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if ((await sizeOf(dest)) === entry.bytes && (await sha256(dest)) === entry.sha256) {
    log("  ok (already copied) " + entry.path);
    return { copied: 0 };
  }
  const part = dest + ".part";
  const etagFile = part + ".etag";
  let have = args.restart ? -1 : await sizeOf(part);
  if (have > 0) {
    let storedEtag = null;
    try {
      storedEtag = (await fsp.readFile(etagFile, "utf8")).trim();
    } catch (e) {}
    if (storedEtag !== entry.etag || have > entry.bytes) {
      log("  partial rejected (source changed or over-long), restarting " + entry.path);
      have = -1;
    }
  }
  if (have <= 0) {
    await fsp.rm(part, { force: true });
    have = 0;
  }
  const resumedFrom = have;
  if (have === entry.bytes) {
    log("  partial already complete, verifying " + entry.path);
  } else {
    const headers = Object.assign({ "If-Match": entry.etag }, auth);
    if (have > 0) headers.Range = "bytes=" + have + "-";
    const res = await fetch(url, { headers });
    if (res.status === 412) {
      await fsp.rm(part, { force: true });
      await fsp.rm(etagFile, { force: true });
      throw new Error("source changed during transfer of " + entry.path + " (HTTP 412); rerun to restart it");
    }
    if (have > 0 && res.status !== 206) {
      await fsp.rm(part, { force: true });
      throw new Error("server ignored Range for " + entry.path + " (HTTP " + res.status + "); rerun with --restart");
    }
    if (!res.ok) throw new Error("download of " + entry.path + " failed (HTTP " + res.status + ")");
    await fsp.writeFile(etagFile, entry.etag);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" }));
  }
  const got = await sizeOf(part);
  if (got !== entry.bytes) {
    throw new Error("size mismatch for " + entry.path + ": got " + got + ", manifest says " + entry.bytes);
  }
  const digest = await sha256(part);
  if (digest !== entry.sha256) {
    await fsp.rm(part, { force: true });
    await fsp.rm(etagFile, { force: true });
    throw new Error("sha256 mismatch for " + entry.path + ": got " + digest + ", manifest says " + entry.sha256);
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  await fsp.rm(etagFile, { force: true });
  log(
    "  copied " + entry.path + " (" + (entry.bytes - resumedFrom) + " of " + entry.bytes + " bytes" +
      (resumedFrom ? ", resumed at " + resumedFrom : "") + ", sha256 " + digest.slice(0, 12) + "…)"
  );
  return { copied: entry.bytes - resumedFrom };
}

async function main() {
  const man = await getManifest();
  const outDir = path.resolve(args.out);
  await fsp.mkdir(outDir, { recursive: true });
  const manifestPath = outDir + ".manifest.json";
  await fsp.writeFile(manifestPath, JSON.stringify(man, null, 2));
  log(
    "manifest: " + man.fileCount + " file(s), " + man.totalBytes + " bytes from " +
      man.scope + " " + man.name + (man.path ? " /" + man.path : "") + " -> " + outDir
  );

  let bytes = 0;
  for (const entry of man.files) {
    const parts = safeRel(entry.path);
    if (!entry.sha256) throw new Error("manifest entry without sha256: " + entry.path);
    const r = await fetchOne(entry, urlForEntry(man, entry.path), path.join(outDir, ...parts));
    bytes += r.copied;
  }
  console.log(
    "FETCH_OK files=" + man.fileCount + " bytes=" + man.totalBytes + " copied=" + bytes +
      " manifest=" + manifestPath
  );
}

main().catch((e) => fail(String((e && e.message) || e)));
