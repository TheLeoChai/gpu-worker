"use strict";
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const fs = require("node:fs");
const path = require("node:path");
const token = (fs.readFileSync(path.join(__dirname, "auth.env"), "utf8").match(/GPU_WORKER_TOKEN=(\S+)/) || [])[1];
const id = process.argv[2];
async function main() {
  const client = new Client({ name: "status-check", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4120/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + token } },
  }));
  const s = await client.callTool({ name: "job_status", arguments: { jobId: id } });
  console.log(JSON.stringify(JSON.parse(s.content[0].text), null, 1));
  await client.close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
