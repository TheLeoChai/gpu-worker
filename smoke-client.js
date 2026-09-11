"use strict";

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const fs = require("node:fs");
const path = require("node:path");

const base = process.argv[2] || "http://127.0.0.1:4120";
const token = (fs.readFileSync(path.join(__dirname, "auth.env"), "utf8").match(/GPU_WORKER_TOKEN=(\S+)/) || [])[1];

async function main() {
  const client = new Client({ name: "smoke-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + token } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(","));

  const gpu = await client.callTool({ name: "gpu_status", arguments: {} });
  console.log("GPU:", JSON.stringify(JSON.parse(gpu.content[0].text)));

  const host = await client.callTool({ name: "host_info", arguments: {} });
  const hi = JSON.parse(host.content[0].text);
  console.log("HOST:", hi.hostname, hi.cpuCores + " cores", hi.ramTotalGB + "GB RAM", hi.gpus[0] && hi.gpus[0].name);

  const job = await client.callTool({
    name: "run_job",
    arguments: {
      repo: "leos-opencode",
      ref: "f9dce2afd550d66b85c1c89915375f0e3a192871",
      command: "node --version && git rev-parse HEAD",
      timeout_minutes: 5,
    },
  });
  const jobId = JSON.parse(job.content[0].text).jobId;
  console.log("JOB:", jobId);

  let status;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    status = JSON.parse((await client.callTool({ name: "job_status", arguments: { jobId } })).content[0].text);
    if (["done", "failed", "timeout", "cancelled"].includes(status.status)) break;
  }
  console.log("STATUS:", JSON.stringify(status));
  if (status.status === "done") {
    const log = JSON.parse((await client.callTool({ name: "job_log", arguments: { jobId, tailLines: 20 } })).content[0].text);
    console.log("LOG TAIL:\n" + log.output);
  }
  await client.close();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("SMOKE FAILED:", e.message);
    process.exit(1);
  }
);
