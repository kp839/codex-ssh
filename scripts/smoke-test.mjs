import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
const [serverName, server] = Object.entries(config.mcpServers)[0];

const child = spawn(server.command, server.args ?? [], {
  cwd: path.resolve(pluginDir, server.cwd ?? "."),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function parseResponses() {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "codex-ssh-smoke", version: "1.0.0" },
  },
});
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

await wait(1200);
child.kill();

const responses = parseResponses();
const tools = responses.find((response) => response.id === 2)?.result?.tools ?? [];
const toolNames = tools.map((tool) => tool.name).sort();
const required = [
  "ssh_connect",
  "ssh_exec",
  "ssh_shell_open",
  "ssh_shell_write",
  "ssh_shell_read",
  "ssh_shell_close",
  "ssh_disconnect",
  "ssh_list_sessions",
  "sftp_upload",
  "sftp_download",
  "sftp_list",
  "sftp_read_text",
  "sftp_write_text",
];
const missing = required.filter((name) => !toolNames.includes(name));

if (missing.length > 0) {
  console.error(stderr);
  throw new Error(`MCP server ${serverName} is missing tools: ${missing.join(", ")}`);
}

console.log(JSON.stringify({
  ok: true,
  serverName,
  toolCount: toolNames.length,
  tools: toolNames,
}, null, 2));
