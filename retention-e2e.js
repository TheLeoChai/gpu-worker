"use strict";
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const fs = require("node:fs");
const path = require("node:path");
const token = (fs.readFileSync(path.join(__dirname, "auth.env"), "utf8").match(/GPU_WORKER_TOKEN=(\S+)/) || [])[1];

async function main() {
  const client = new Client({ name: "retention-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4120/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + token } },
  }));

  for (let i = 1; i <= 4; i++) {
    const job = await client.callTool({
      name: "run_job",
      arguments: { repo: "leos-opencode", ref: "f9dce2afd550d66b85c1c89915375f0e3a192871", command: "echo retention-test-" + i, timeout_minutes: 5 },
    });
    const jobId = JSON.parse(job.content[0].text).jobId;
    let status;
    for (let t = 0; t < 60; t++) {
      await new Promise((r) => setTimeout(r, 3000));
      status = JSON.parse((await client.callTool({ name: "job_status", arguments: { jobId } })).content[0].text);
      if (["done", "failed", "timeout", "cancelled"].includes(status.status)) break;
    }
    console.log("job", i, "->", status.status);
    if (status.status !== "done") process.exit(1);
  }
  await client.close();
}
main().then(() => process.exit(0), (e) => { console.error("FAILED:", e.message); process.exit(1); });
