"use strict";
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const fs = require("node:fs");
const path = require("node:path");

const token = (fs.readFileSync(path.join(__dirname, "auth.env"), "utf8").match(/GPU_WORKER_TOKEN=(\S+)/) || [])[1];

async function main() {
  const client = new Client({ name: "migrate-check", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4120/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + token } },
  });
  await client.connect(transport);
  const jobs = await client.callTool({ name: "list_jobs", arguments: {} });
  console.log("=== LIVE JOBS ===");
  console.log(jobs.content[0].text.slice(0, 1000));

  const job = await client.callTool({
    name: "run_job",
    arguments: {
      repo: "leos-opencode",
      ref: "f9dce2afd550d66b85c1c89915375f0e3a192871",
      command: "node --version && git rev-parse HEAD && cd",
      timeout_minutes: 8,
    },
  });
  const jobId = JSON.parse(job.content[0].text).jobId;
  console.log("SMOKE JOB:", jobId);
  let status;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await client.callTool({ name: "job_status", arguments: { jobId } });
    status = JSON.parse(s.content[0].text);
    if (status.status !== "queued" && status.status !== "running") break;
  }
  console.log("FINAL:", JSON.stringify(status));
  if (status.status === "done") {
    const log = await client.callTool({ name: "job_log", arguments: { jobId, tailLines: 6 } });
    console.log("LOG TAIL:", log.content[0].text.slice(-300));
  }
  await client.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e.message); process.exit(1); });
