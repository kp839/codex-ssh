# Codex SSH

Codex SSH is a local Codex plugin that exposes SSH and SFTP operations through MCP tools. It lets Codex connect to remote hosts, run commands, keep interactive shells open, and transfer files without writing one-off SSH scripts for each task.

## Features

- Reusable SSH sessions with `ssh_connect` and `ssh_disconnect`
- One-off remote commands with `ssh_exec`
- Persistent interactive shells with `ssh_shell_open`, `ssh_shell_write`, and `ssh_shell_read`
- SFTP upload, download, list, read, and write helpers
- Optional SSH agent, private key, password, keyboard-interactive, and host fingerprint support
- Credentials are passed to the MCP process at call time and are not written to plugin files

## Repository Layout

```text
.codex-plugin/plugin.json   Codex plugin metadata
.mcp.json                   MCP server registration
mcp/server.mjs              Local MCP server implementation
mcp/package.json            Node package metadata
scripts/start-mcp.cmd       Windows launcher used by Codex
scripts/smoke-test.mjs      Tool-list smoke test
skills/codex-ssh/SKILL.md   Skill instructions for Codex
```

## Development

Install dependencies from the MCP package:

```powershell
cd mcp
npm ci
```

Run the smoke test from the plugin root:

```powershell
node scripts/smoke-test.mjs
```

The smoke test starts the configured MCP server, calls `initialize`, requests `tools/list`, and verifies the expected SSH and SFTP tools are present.

## Security Notes

- Do not commit private keys, passwords, host inventories, or `.env` files.
- Prefer SSH keys or SSH agent authentication over passwords.
- Pass `hostFingerprintSha256` when you know the server fingerprint.
- `ProxyJump` and `ProxyCommand` entries from `~/.ssh/config` are intentionally ignored by this plugin.

## MCP Tools

- `ssh_connect`
- `ssh_exec`
- `ssh_shell_open`
- `ssh_shell_write`
- `ssh_shell_read`
- `ssh_shell_close`
- `ssh_disconnect`
- `ssh_list_sessions`
- `sftp_upload`
- `sftp_download`
- `sftp_list`
- `sftp_read_text`
- `sftp_write_text`

## License

No license has been selected yet. Add a license before treating this repository as open source.

