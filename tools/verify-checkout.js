"use strict";

// Verify that working-tree bytes equal the committed blobs (LEO-182).
//
// Windows checkouts with core.autocrlf=true rewrite LF -> CRLF, which silently
// breaks anything hash-bound to the committed bytes (transfer bundles, .cmd
// wrappers). This compares `git hash-object --no-filters <file>` with the blob
// id in the index, so it catches every smudge-time rewrite, whatever caused it.
//
//   node tools/verify-checkout.js [--require-eol-lock] [--json] [path...]
//
// Paths default to the whole repo. --require-eol-lock additionally fails when a
// file has no .gitattributes eol lock (`-text` or `eol=lf`); every transfer dir
// must carry one. Exit 0 = clean, 1 = drift/unlocked files, 2 = usage/git error.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function git(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("git " + args[0] + " failed: " + Buffer.concat(err).toString().trim()));
      resolve(Buffer.concat(out).toString("utf8"));
    });
    if (child.stdin) {
      // git may exit before draining stdin; its exit code reports the real error
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// A file is eol-locked when checkout can never rewrite it: binary (-text) or
// forced LF (eol=lf). `text eol=crlf` is an intentional rewrite, not a lock.
function isLocked(attrs) {
  return attrs.text === "unset" || attrs.eol === "lf";
}

function isIntentionalConversion(attrs) {
  return attrs.eol === "crlf" || attrs.text === "set" || (attrs.filter && attrs.filter !== "unspecified");
}

async function verifyCheckout(cwd, paths) {
  const ls = await git(cwd, ["ls-files", "-s", "-z", "--", ...(paths && paths.length ? paths : ["."])]);
  const entries = [];
  for (const rec of ls.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, blob] = rec.slice(0, tab).split(" ");
    // symlinks and submodules have no comparable working-tree bytes
    if (mode === "120000" || mode === "160000") continue;
    entries.push({ path: rec.slice(tab + 1), blob });
  }
  if (!entries.length) return { checked: 0, drift: [], unlocked: [] };

  const attrOut = await git(cwd, ["check-attr", "-z", "--stdin", "text", "eol", "filter"], entries.map((e) => e.path).join("\0"));
  const attrs = new Map();
  const parts = attrOut.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (!attrs.has(parts[i])) attrs.set(parts[i], {});
    attrs.get(parts[i])[parts[i + 1]] = parts[i + 2];
  }

  // hash-object aborts on a missing file, so filter those out first
  const drift = [];
  const present = [];
  for (const e of entries) {
    if (fs.existsSync(path.join(cwd, e.path))) present.push(e);
    else drift.push({ path: e.path, reason: "missing" });
  }
  const hashes = present.length
    ? (await git(cwd, ["hash-object", "--no-filters", "--stdin-paths"], present.map((e) => e.path).join("\n") + "\n")).split(/\r?\n/)
    : [];
  present.forEach((e, i) => {
    if (hashes[i] !== e.blob) {
      const a = attrs.get(e.path) || {};
      drift.push({ path: e.path, reason: "bytes differ from committed blob", intentional: !!isIntentionalConversion(a) });
    }
  });
  const unlocked = entries.filter((e) => !isLocked(attrs.get(e.path) || {})).map((e) => e.path);
  return { checked: entries.length, drift, unlocked };
}

module.exports = { verifyCheckout };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const requireLock = argv.includes("--require-eol-lock");
  const asJson = argv.includes("--json");
  const paths = argv.filter((a) => !a.startsWith("--"));
  verifyCheckout(process.cwd(), paths).then(
    (r) => {
      // an explicit path that matches nothing is a typo, not a clean tree
      const failed = r.drift.length > 0 || (requireLock && r.unlocked.length > 0) || (paths.length > 0 && r.checked === 0);
      if (asJson) {
        console.log(JSON.stringify(Object.assign({ ok: !failed, requireEolLock: requireLock }, r), null, 2));
      } else {
        console.log("checked " + r.checked + " file(s)");
        for (const d of r.drift) console.log("DRIFT   " + d.path + " (" + d.reason + (d.intentional ? ", .gitattributes requests conversion" : "") + ")");
        if (requireLock) for (const p of r.unlocked) console.log("UNLOCKED " + p + " (add `-text` or `eol=lf` in .gitattributes)");
        console.log(failed ? "FAIL" : "OK");
      }
      process.exit(failed ? 1 : 0);
    },
    (e) => {
      console.error("verify-checkout: " + e.message);
      process.exit(2);
    }
  );
}
