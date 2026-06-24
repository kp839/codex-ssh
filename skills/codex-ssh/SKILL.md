---
name: codex-ssh
description: Use this skill when Codex needs to connect to a remote server over SSH, run deployment or diagnostic commands, keep an interactive shell open, or move files with SFTP. Prefer the bundled MCP tools instead of writing one-off SSH scripts.
---

# Codex SSH

Use the `codex-ssh` MCP tools for SSH work instead of creating ad hoc scripts. This skill is safe to invoke automatically when a user asks Codex to connect to a server, deploy to a server, inspect a remote host, run remote commands, or transfer files over SSH/SFTP.

## Typical Flow

1. Use `ssh_connect` when you need a reusable connection.
2. Use `ssh_exec` for normal commands.
3. Use `ssh_shell_open`, `ssh_shell_write`, and `ssh_shell_read` when a task is interactive.
4. Use `sftp_upload`, `sftp_download`, `sftp_read_text`, `sftp_write_text`, and `sftp_list` for remote files.
5. Use `ssh_disconnect` when the task is complete.

For one-off commands or file transfers, most tools also accept connection fields directly:
`host`, `port`, `username`, `password`, `privateKey`, `privateKeyPath`, and `passphrase`.

## Security

- Do not persist user passwords or private keys in project files.
- Prefer SSH keys or existing server-side accounts with least privilege.
- If the user provides a password, pass it directly to the tool and do not repeat it in summaries.
- When the host fingerprint is known, pass `hostFingerprintSha256` to verify the host key.

## Notes

- `ssh_exec` is best for non-interactive commands.
- Use `ssh_shell_open` for commands that prompt, long-running installers, or REPL-like workflows.
- Remote shell helpers assume a POSIX-like server when using `cwd` or `env`.
