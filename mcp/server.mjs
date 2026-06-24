import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";

const { Client } = ssh2;

const SERVER_NAME = "codex-ssh";
const SERVER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_SHELL_BUFFER_BYTES = 256_000;

const sessions = new Map();
const shells = new Map();
let nextSessionId = 1;
let nextShellId = 1;
let responseMode = "line";
let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on("end", () => {
  closeAllSessions();
});

process.on("SIGINT", () => {
  closeAllSessions();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeAllSessions();
  process.exit(0);
});

function drainInput() {
  while (inputBuffer.length > 0) {
    const parsed = readNextMessage(inputBuffer);
    if (!parsed) return;
    inputBuffer = parsed.rest;
    responseMode = parsed.mode;
    handleMessage(parsed.message).catch((error) => {
      logError("Unhandled message error", error);
    });
  }
}

function readNextMessage(buffer) {
  const ascii = buffer.toString("ascii", 0, Math.min(buffer.length, 32));
  if (/^Content-Length:/i.test(ascii)) {
    const text = buffer.toString("utf8");
    let headerEnd = text.indexOf("\r\n\r\n");
    let delimiterLength = 4;
    if (headerEnd === -1) {
      headerEnd = text.indexOf("\n\n");
      delimiterLength = 2;
    }
    if (headerEnd === -1) return null;

    const header = text.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      throw new Error("Missing Content-Length header");
    }

    const length = Number(match[1]);
    const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + delimiterLength), "utf8");
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return null;

    const raw = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    return {
      message: JSON.parse(raw),
      rest: buffer.subarray(bodyEnd),
      mode: "header",
    };
  }

  const newline = buffer.indexOf(0x0a);
  if (newline === -1) return null;
  const raw = buffer.subarray(0, newline).toString("utf8").trim();
  if (!raw) {
    return {
      message: null,
      rest: buffer.subarray(newline + 1),
      mode: "line",
    };
  }
  return {
    message: JSON.parse(raw),
    rest: buffer.subarray(newline + 1),
    mode: "line",
  };
}

async function handleMessage(message) {
  if (!message) return;
  const { id, method, params } = message;

  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
      return;
    }

    if (method === "notifications/initialized") return;
    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: toolDefinitions() });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        const text = await callTool(name, args);
        sendResult(id, {
          content: [{ type: "text", text }],
          isError: false,
        });
      } catch (error) {
        sendResult(id, {
          content: [{ type: "text", text: redactMessage(error, args) }],
          isError: true,
        });
      }
      return;
    }

    if (method === "shutdown") {
      closeAllSessions();
      sendResult(id, {});
      return;
    }

    if (method === "exit") {
      closeAllSessions();
      setTimeout(() => process.exit(0), 10).unref();
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    sendError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function sendResult(id, result) {
  if (id === undefined || id === null) return;
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data = undefined) {
  if (id === undefined || id === null) return;
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: "2.0", id, error });
}

function writeMessage(message) {
  const raw = JSON.stringify(message);
  if (responseMode === "header") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(raw, "utf8")}\r\n\r\n${raw}`);
  } else {
    process.stdout.write(`${raw}\n`);
  }
}

function toolDefinitions() {
  return [
    {
      name: "ssh_connect",
      description: "Open a reusable SSH connection. Credentials are kept only in memory for this MCP process.",
      inputSchema: {
        type: "object",
        properties: connectionProperties(),
        required: ["host"],
        additionalProperties: false,
      },
    },
    {
      name: "ssh_exec",
      description: "Run a non-interactive command over SSH. Use sessionId for an existing connection or pass host credentials for a one-off connection.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          ...connectionProperties(),
          command: { type: "string", description: "Remote command to execute." },
          cwd: { type: "string", description: "Optional remote working directory. Assumes a POSIX-like shell." },
          env: {
            type: "object",
            description: "Optional remote environment variables. Values are converted to strings.",
            additionalProperties: { type: ["string", "number", "boolean"] },
          },
          stdin: { type: "string", description: "Optional stdin to send to the command." },
          pty: { type: "boolean", description: "Allocate a pseudo-terminal for commands that need TTY behavior." },
          timeoutMs: { type: "number", description: "Command timeout in milliseconds." },
          maxOutputChars: { type: "number", description: "Maximum characters returned for stdout and stderr." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "ssh_shell_open",
      description: "Open a persistent interactive shell or PTY command. Use ssh_shell_write and ssh_shell_read to interact with it.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          ...connectionProperties(),
          command: { type: "string", description: "Optional command to run inside a PTY instead of opening the default shell." },
          term: { type: "string", description: "Terminal type.", default: "xterm-256color" },
          cols: { type: "number", description: "PTY columns.", default: 120 },
          rows: { type: "number", description: "PTY rows.", default: 40 },
          waitMs: { type: "number", description: "Milliseconds to wait before returning initial output.", default: 400 },
          maxOutputChars: { type: "number", description: "Maximum initial output characters.", default: 12000 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "ssh_shell_write",
      description: "Write text to an interactive SSH shell.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: shellIdProperty(),
          text: { type: "string", description: "Text to write." },
          appendNewline: { type: "boolean", description: "Append a newline after text.", default: false },
        },
        required: ["shellId", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "ssh_shell_read",
      description: "Read buffered output from an interactive SSH shell.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: shellIdProperty(),
          waitMs: { type: "number", description: "Milliseconds to wait for more output before reading.", default: 300 },
          clear: { type: "boolean", description: "Clear returned output from the buffer.", default: true },
          maxOutputChars: { type: "number", description: "Maximum output characters.", default: 20000 },
        },
        required: ["shellId"],
        additionalProperties: false,
      },
    },
    {
      name: "ssh_shell_close",
      description: "Close an interactive SSH shell.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: shellIdProperty(),
        },
        required: ["shellId"],
        additionalProperties: false,
      },
    },
    {
      name: "ssh_disconnect",
      description: "Close a reusable SSH connection and any shells attached to it.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
    {
      name: "ssh_list_sessions",
      description: "List currently open SSH sessions and shells.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "sftp_upload",
      description: "Upload a local file to the remote host via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          ...connectionProperties(),
          localPath: { type: "string", description: "Local file path." },
          remotePath: { type: "string", description: "Remote destination path." },
          mkdir: { type: "boolean", description: "Create remote parent directories if needed.", default: true },
        },
        required: ["localPath", "remotePath"],
        additionalProperties: false,
      },
    },
    {
      name: "sftp_download",
      description: "Download a remote file to the local machine via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          ...connectionProperties(),
          remotePath: { type: "string", description: "Remote source path." },
          localPath: { type: "string", description: "Local destination path." },
        },
        required: ["remotePath", "localPath"],
        additionalProperties: false,
      },
    },
    {
      name: "sftp_list",
      description: "List a remote directory via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          ...connectionProperties(),
          remotePath: { type: "string", description: "Remote directory path.", default: "." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "sftp_read_text",
      description: "Read the beginning of a remote text file via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          ...connectionProperties(),
          remotePath: { type: "string", description: "Remote file path." },
          encoding: { type: "string", description: "Text encoding.", default: "utf8" },
          maxBytes: { type: "number", description: "Maximum bytes to read.", default: 200000 },
        },
        required: ["remotePath"],
        additionalProperties: false,
      },
    },
    {
      name: "sftp_write_text",
      description: "Write text to a remote file via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          ...connectionProperties(),
          remotePath: { type: "string", description: "Remote file path." },
          text: { type: "string", description: "Text to write." },
          encoding: { type: "string", description: "Text encoding.", default: "utf8" },
          mkdir: { type: "boolean", description: "Create remote parent directories if needed.", default: true },
        },
        required: ["remotePath", "text"],
        additionalProperties: false,
      },
    },
  ];
}

function connectionProperties() {
  return {
    host: { type: "string", description: "Remote host, user@host, or a basic ~/.ssh/config Host alias." },
    port: { type: "number", description: "SSH port.", default: 22 },
    username: { type: "string", description: "SSH username. Can be omitted when host is user@host." },
    password: { type: "string", description: "SSH password. Kept only in memory." },
    privateKey: { type: "string", description: "Private key contents. Kept only in memory." },
    privateKeyPath: { type: "string", description: "Path to a private key file on the local machine." },
    passphrase: { type: "string", description: "Private key passphrase. Kept only in memory." },
    agent: {
      type: ["boolean", "string"],
      description: "Use SSH agent. true uses SSH_AUTH_SOCK; a string is used as the agent socket path.",
    },
    tryKeyboard: { type: "boolean", description: "Enable keyboard-interactive auth. Defaults to true when password is set." },
    readyTimeoutMs: { type: "number", description: "Connection timeout in milliseconds.", default: DEFAULT_READY_TIMEOUT_MS },
    keepaliveIntervalMs: { type: "number", description: "SSH keepalive interval in milliseconds." },
    hostFingerprintSha256: {
      type: "string",
      description: "Optional expected SHA256 host key fingerprint, for example SHA256:abc... from ssh-keygen.",
    },
  };
}

function sessionIdProperty() {
  return { type: "string", description: "Reusable SSH session id returned by ssh_connect." };
}

function shellIdProperty() {
  return { type: "string", description: "Interactive shell id returned by ssh_shell_open." };
}

async function callTool(name, args) {
  switch (name) {
    case "ssh_connect":
      return jsonText(await toolSshConnect(args));
    case "ssh_exec":
      return jsonText(await toolSshExec(args));
    case "ssh_shell_open":
      return jsonText(await toolShellOpen(args));
    case "ssh_shell_write":
      return jsonText(await toolShellWrite(args));
    case "ssh_shell_read":
      return jsonText(await toolShellRead(args));
    case "ssh_shell_close":
      return jsonText(await toolShellClose(args));
    case "ssh_disconnect":
      return jsonText(await toolDisconnect(args));
    case "ssh_list_sessions":
      return jsonText(await toolListSessions());
    case "sftp_upload":
      return jsonText(await toolSftpUpload(args));
    case "sftp_download":
      return jsonText(await toolSftpDownload(args));
    case "sftp_list":
      return jsonText(await toolSftpList(args));
    case "sftp_read_text":
      return jsonText(await toolSftpReadText(args));
    case "sftp_write_text":
      return jsonText(await toolSftpWriteText(args));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function toolSshConnect(args) {
  const session = await createSession(args, { store: true });
  return {
    ok: true,
    sessionId: session.id,
    alias: session.alias,
    host: session.host,
    port: session.port,
    username: session.username,
    configWarnings: session.configWarnings,
    warning: session.verifiedHostKey ? undefined : "Host key was not verified. Pass hostFingerprintSha256 when you know the server fingerprint.",
  };
}

async function toolSshExec(args) {
  assertString(args.command, "command");
  const { session, closeAfter } = await getSession(args);
  const start = Date.now();

  try {
    const result = await execOnSession(session, args);
    return {
      ok: !result.timedOut && result.exitCode === 0,
      sessionId: session.id,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: Date.now() - start,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    if (closeAfter) endSession(session);
  }
}

async function toolShellOpen(args) {
  const { session } = args.sessionId
    ? await getSession(args)
    : { session: await createSession(args, { store: true }) };

  const shellId = `shell-${nextShellId++}`;
  const pty = {
    term: typeof args.term === "string" ? args.term : "xterm-256color",
    cols: clampInteger(args.cols, 20, 300, 120),
    rows: clampInteger(args.rows, 8, 120, 40),
  };

  const stream = await openShellStream(session.conn, args.command, pty);
  const shell = {
    id: shellId,
    sessionId: session.id,
    stream,
    buffer: Buffer.alloc(0),
    closed: false,
    createdAt: new Date().toISOString(),
  };

  stream.on("data", (chunk) => appendShellOutput(shell, chunk));
  stream.stderr?.on("data", (chunk) => appendShellOutput(shell, chunk));
  stream.on("close", () => {
    shell.closed = true;
  });
  stream.on("error", (error) => {
    appendShellOutput(shell, Buffer.from(`\n[stream error] ${error.message}\n`));
    shell.closed = true;
  });

  shells.set(shellId, shell);
  session.shells.add(shellId);
  touchSession(session);

  await sleep(numberOrDefault(args.waitMs, 400));
  return {
    ok: true,
    sessionId: session.id,
    shellId,
    closed: shell.closed,
    output: readShellBuffer(shell, {
      maxOutputChars: numberOrDefault(args.maxOutputChars, 12_000),
      clear: true,
    }),
  };
}

async function toolShellWrite(args) {
  const shell = getShell(args.shellId);
  assertString(args.text, "text");
  if (shell.closed) throw new Error(`Shell is closed: ${shell.id}`);
  const text = args.appendNewline ? `${args.text}\n` : args.text;
  shell.stream.write(text);
  return { ok: true, shellId: shell.id, bytesWritten: Buffer.byteLength(text, "utf8") };
}

async function toolShellRead(args) {
  const shell = getShell(args.shellId);
  await sleep(numberOrDefault(args.waitMs, 300));
  return {
    ok: true,
    shellId: shell.id,
    closed: shell.closed,
    output: readShellBuffer(shell, {
      maxOutputChars: numberOrDefault(args.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS),
      clear: args.clear !== false,
    }),
  };
}

async function toolShellClose(args) {
  const shell = getShell(args.shellId);
  closeShell(shell.id);
  return { ok: true, shellId: shell.id };
}

async function toolDisconnect(args) {
  assertString(args.sessionId, "sessionId");
  const existed = sessions.has(args.sessionId);
  closeSession(args.sessionId);
  return { ok: true, sessionId: args.sessionId, existed };
}

async function toolListSessions() {
  return {
    sessions: [...sessions.values()].map((session) => ({
      sessionId: session.id,
      alias: session.alias,
      host: session.host,
      port: session.port,
      username: session.username,
      configWarnings: session.configWarnings,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      shells: [...session.shells].filter((shellId) => shells.has(shellId)),
      closed: session.closed,
    })),
    shells: [...shells.values()].map((shell) => ({
      shellId: shell.id,
      sessionId: shell.sessionId,
      closed: shell.closed,
      bufferedBytes: shell.buffer.length,
      createdAt: shell.createdAt,
    })),
  };
}

async function toolSftpUpload(args) {
  assertString(args.localPath, "localPath");
  assertString(args.remotePath, "remotePath");
  const localPath = resolveLocalPath(args.localPath);
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
    throw new Error(`Local file does not exist: ${localPath}`);
  }

  return withSftp(args, async (sftp, session) => {
    if (args.mkdir !== false) {
      await sftpMkdirp(sftp, posixDirname(args.remotePath));
    }
    await sftpFastPut(sftp, localPath, args.remotePath);
    return {
      ok: true,
      sessionId: session.id,
      localPath,
      remotePath: args.remotePath,
      bytes: fs.statSync(localPath).size,
    };
  });
}

async function toolSftpDownload(args) {
  assertString(args.remotePath, "remotePath");
  assertString(args.localPath, "localPath");
  const localPath = resolveLocalPath(args.localPath);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  return withSftp(args, async (sftp, session) => {
    await sftpFastGet(sftp, args.remotePath, localPath);
    return {
      ok: true,
      sessionId: session.id,
      remotePath: args.remotePath,
      localPath,
      bytes: fs.statSync(localPath).size,
    };
  });
}

async function toolSftpList(args) {
  const remotePath = typeof args.remotePath === "string" ? args.remotePath : ".";
  return withSftp(args, async (sftp, session) => {
    const entries = await sftpReaddir(sftp, remotePath);
    return {
      ok: true,
      sessionId: session.id,
      remotePath,
      entries: entries.map((entry) => ({
        filename: entry.filename,
        longname: entry.longname,
        attrs: entry.attrs,
      })),
    };
  });
}

async function toolSftpReadText(args) {
  assertString(args.remotePath, "remotePath");
  const maxBytes = clampInteger(args.maxBytes, 1, 5_000_000, 200_000);
  const encoding = typeof args.encoding === "string" ? args.encoding : "utf8";

  return withSftp(args, async (sftp, session) => {
    const result = await sftpReadPrefix(sftp, args.remotePath, maxBytes);
    return {
      ok: true,
      sessionId: session.id,
      remotePath: args.remotePath,
      encoding,
      truncated: result.truncated,
      bytesRead: result.bytesRead,
      text: result.data.toString(encoding),
    };
  });
}

async function toolSftpWriteText(args) {
  assertString(args.remotePath, "remotePath");
  assertString(args.text, "text");
  const encoding = typeof args.encoding === "string" ? args.encoding : "utf8";

  return withSftp(args, async (sftp, session) => {
    if (args.mkdir !== false) {
      await sftpMkdirp(sftp, posixDirname(args.remotePath));
    }
    const data = Buffer.from(args.text, encoding);
    await sftpWriteFile(sftp, args.remotePath, data);
    return {
      ok: true,
      sessionId: session.id,
      remotePath: args.remotePath,
      bytes: data.length,
    };
  });
}

async function getSession(args) {
  if (typeof args.sessionId === "string" && args.sessionId.trim()) {
    const session = sessions.get(args.sessionId);
    if (!session || session.closed) throw new Error(`Unknown or closed sessionId: ${args.sessionId}`);
    touchSession(session);
    return { session, closeAfter: false };
  }
  const session = await createSession(args, { store: false });
  return { session, closeAfter: true };
}

async function createSession(args, { store }) {
  const connectArgs = normalizeConnectArgs(args);
  const conn = new Client();
  const sessionId = store ? `ssh-${nextSessionId++}` : `oneshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const verifiedHostKey = Boolean(connectArgs.hostFingerprintSha256);

  const config = buildSshConfig(connectArgs);
  await connectClient(conn, config, connectArgs.password);

  const session = {
    id: sessionId,
    conn,
    alias: connectArgs.alias,
    host: connectArgs.host,
    port: connectArgs.port,
    username: connectArgs.username,
    verifiedHostKey,
    configWarnings: connectArgs.configWarnings,
    shells: new Set(),
    closed: false,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };

  conn.on("close", () => {
    session.closed = true;
    for (const shellId of [...session.shells]) closeShell(shellId);
    if (store) sessions.delete(session.id);
  });
  conn.on("error", (error) => {
    logError(`SSH session error for ${session.id}`, error);
  });

  if (store) sessions.set(session.id, session);
  return session;
}

function normalizeConnectArgs(args) {
  let host = stringOrEmpty(args.host);
  let username = stringOrEmpty(args.username);
  let port = args.port === undefined ? undefined : numberOrDefault(args.port, 22);

  if (!host) throw new Error("Missing host or sessionId");

  const atIndex = host.lastIndexOf("@");
  if (!username && atIndex > 0) {
    username = host.slice(0, atIndex);
    host = host.slice(atIndex + 1);
  }

  const hostPort = host.match(/^([^:\][]+):(\d+)$/);
  if (hostPort) {
    host = hostPort[1];
    port = Number(hostPort[2]);
  }

  const alias = host;
  const sshConfig = readOpenSshConfig(alias);
  host = sshConfig.hostname ?? host;
  username = username || sshConfig.user || "";
  port = port ?? sshConfig.port ?? 22;

  if (!username) {
    username = os.userInfo().username;
  }

  const privateKeyPath = maybeString(args.privateKeyPath)
    ?? firstUsableIdentityFile(sshConfig.identityFiles, { alias, host, username, port });

  return {
    alias,
    host,
    port,
    username,
    password: maybeString(args.password),
    privateKey: maybeString(args.privateKey),
    privateKeyPath,
    passphrase: maybeString(args.passphrase),
    agent: args.agent,
    tryKeyboard: args.tryKeyboard,
    readyTimeoutMs: numberOrDefault(args.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS),
    keepaliveIntervalMs: args.keepaliveIntervalMs,
    hostFingerprintSha256: maybeString(args.hostFingerprintSha256),
    configWarnings: sshConfig.warnings,
  };
}

function buildSshConfig(args) {
  const config = {
    host: args.host,
    port: args.port,
    username: args.username,
    readyTimeout: args.readyTimeoutMs,
    tryKeyboard: args.tryKeyboard ?? Boolean(args.password),
  };

  if (args.password) config.password = args.password;
  if (args.passphrase) config.passphrase = args.passphrase;
  if (args.privateKeyPath) config.privateKey = fs.readFileSync(resolveLocalPath(args.privateKeyPath), "utf8");
  if (args.privateKey) config.privateKey = args.privateKey.replace(/\\n/g, "\n");

  const agent = resolveAgent(args.agent);
  if (agent) config.agent = agent;

  if (Number.isFinite(Number(args.keepaliveIntervalMs))) {
    config.keepaliveInterval = Number(args.keepaliveIntervalMs);
  }

  if (args.hostFingerprintSha256) {
    config.hostHash = "sha256";
    config.hostVerifier = (hashedKey) => compareSha256Fingerprint(hashedKey, args.hostFingerprintSha256);
  }

  return config;
}

function connectClient(conn, config, password) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      conn.off("ready", onReady);
      conn.off("error", onError);
      conn.off("keyboard-interactive", onKeyboardInteractive);
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onKeyboardInteractive = (_name, _instructions, _lang, prompts, finish) => {
      if (!password) return finish([]);
      finish(prompts.map(() => password));
    };

    conn.on("ready", onReady);
    conn.on("error", onError);
    conn.on("keyboard-interactive", onKeyboardInteractive);
    conn.connect(config);
  });
}

function execOnSession(session, args) {
  const command = buildRemoteCommand(args);
  const timeoutMs = numberOrDefault(args.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1, numberOrDefault(args.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS)) * 4;
  const stdout = createTailCollector(maxOutputBytes);
  const stderr = createTailCollector(maxOutputBytes);

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let streamRef = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        streamRef?.signal?.("TERM");
      } catch {
        // Best effort only.
      }
      setTimeout(() => {
        try {
          streamRef?.close?.();
        } catch {
          // Best effort only.
        }
      }, 500).unref();
    }, timeoutMs);

    session.conn.exec(command, execOptions(args), (error, stream) => {
      if (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }

      streamRef = stream;
      stream.on("data", (chunk) => stdout.push(chunk));
      stream.stderr.on("data", (chunk) => stderr.push(chunk));
      stream.on("error", (streamError) => {
        clearTimeout(timer);
        reject(streamError);
      });
      stream.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        touchSession(session);
        resolve({
          exitCode,
          signal,
          timedOut,
          stdout: stdout.text(),
          stderr: stderr.text(),
        });
      });

      if (typeof args.stdin === "string") {
        stream.write(args.stdin);
      }
      stream.end();
    });
  });
}

function buildRemoteCommand(args) {
  let command = args.command;
  const prefix = [];

  if (typeof args.cwd === "string" && args.cwd.trim()) {
    prefix.push(`cd ${shQuote(args.cwd)} &&`);
  }

  if (args.env && typeof args.env === "object" && !Array.isArray(args.env)) {
    for (const [key, value] of Object.entries(args.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: ${key}`);
      }
      prefix.push(`${key}=${shQuote(String(value))}`);
    }
  }

  if (prefix.length > 0) {
    command = `${prefix.join(" ")} ${command}`;
  }

  return command;
}

function execOptions(args) {
  if (!args.pty) return {};
  return {
    pty: {
      term: "xterm-256color",
      cols: 120,
      rows: 40,
    },
  };
}

function openShellStream(conn, command, pty) {
  return new Promise((resolve, reject) => {
    if (typeof command === "string" && command.trim()) {
      conn.exec(command, { pty }, (error, stream) => {
        if (error) reject(error);
        else resolve(stream);
      });
      return;
    }

    conn.shell(pty, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function appendShellOutput(shell, chunk) {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  shell.buffer = Buffer.concat([shell.buffer, data]);
  if (shell.buffer.length > MAX_SHELL_BUFFER_BYTES) {
    shell.buffer = shell.buffer.subarray(shell.buffer.length - MAX_SHELL_BUFFER_BYTES);
  }
}

function readShellBuffer(shell, { maxOutputChars, clear }) {
  const maxBytes = Math.max(1, maxOutputChars) * 4;
  const data = shell.buffer.length > maxBytes
    ? Buffer.concat([Buffer.from(`[truncated ${shell.buffer.length - maxBytes} bytes]\n`), shell.buffer.subarray(shell.buffer.length - maxBytes)])
    : shell.buffer;
  if (clear) shell.buffer = Buffer.alloc(0);
  return data.toString("utf8");
}

async function withSftp(args, callback) {
  const { session, closeAfter } = await getSession(args);
  let sftp = null;
  try {
    sftp = await openSftp(session.conn);
    const result = await callback(sftp, session);
    touchSession(session);
    return result;
  } finally {
    try {
      sftp?.end?.();
    } catch {
      // Best effort only.
    }
    if (closeAfter) endSession(session);
  }
}

function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function sftpFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve());
  });
}

function sftpFastGet(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => error ? reject(error) : resolve());
  });
}

function sftpReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => error ? reject(error) : resolve(list));
  });
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => error ? reject(error) : resolve(stats));
  });
}

function sftpMkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => error ? reject(error) : resolve());
  });
}

function sftpOpen(sftp, remotePath, flags) {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, flags, (error, handle) => error ? reject(error) : resolve(handle));
  });
}

function sftpRead(sftp, handle, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, offset, length, position, (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
  });
}

function sftpClose(sftp, handle) {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (error) => error ? reject(error) : resolve());
  });
}

function sftpWriteFile(sftp, remotePath, data) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, data, (error) => error ? reject(error) : resolve());
  });
}

async function sftpReadPrefix(sftp, remotePath, maxBytes) {
  const handle = await sftpOpen(sftp, remotePath, "r");
  const buffer = Buffer.alloc(maxBytes + 1);
  try {
    const bytesRead = await sftpRead(sftp, handle, buffer, 0, maxBytes + 1, 0);
    return {
      data: buffer.subarray(0, Math.min(bytesRead, maxBytes)),
      bytesRead: Math.min(bytesRead, maxBytes),
      truncated: bytesRead > maxBytes,
    };
  } finally {
    await sftpClose(sftp, handle);
  }
}

async function sftpMkdirp(sftp, remoteDir) {
  if (!remoteDir || remoteDir === "." || remoteDir === "/") return;

  const absolute = remoteDir.startsWith("/");
  const parts = remoteDir.split("/").filter(Boolean);
  let current = absolute ? "/" : "";

  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    try {
      await sftpStat(sftp, current);
    } catch {
      try {
        await sftpMkdir(sftp, current);
      } catch {
        await sftpStat(sftp, current);
      }
    }
  }
}

function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  endSession(session);
}

function endSession(session) {
  for (const shellId of [...session.shells]) closeShell(shellId);
  sessions.delete(session.id);
  session.closed = true;
  try {
    session.conn.end();
  } catch {
    // Best effort only.
  }
}

function closeShell(shellId) {
  const shell = shells.get(shellId);
  if (!shell) return;
  shells.delete(shellId);
  const session = sessions.get(shell.sessionId);
  session?.shells.delete(shellId);
  shell.closed = true;
  try {
    shell.stream.end();
  } catch {
    // Best effort only.
  }
  try {
    shell.stream.close?.();
  } catch {
    // Best effort only.
  }
}

function closeAllSessions() {
  for (const shellId of [...shells.keys()]) closeShell(shellId);
  for (const sessionId of [...sessions.keys()]) closeSession(sessionId);
}

function getShell(shellId) {
  assertString(shellId, "shellId");
  const shell = shells.get(shellId);
  if (!shell) throw new Error(`Unknown shellId: ${shellId}`);
  return shell;
}

function touchSession(session) {
  session.lastUsedAt = new Date().toISOString();
}

function createTailCollector(maxBytes) {
  let buffer = Buffer.alloc(0);
  let omittedBytes = 0;

  return {
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > maxBytes) {
        const overflow = buffer.length - maxBytes;
        omittedBytes += overflow;
        buffer = buffer.subarray(overflow);
      }
    },
    text() {
      const prefix = omittedBytes > 0 ? `[truncated ${omittedBytes} bytes]\n` : "";
      return `${prefix}${buffer.toString("utf8")}`;
    },
  };
}

function readOpenSshConfig(hostAlias) {
  const result = {
    hostname: undefined,
    user: undefined,
    port: undefined,
    identityFiles: [],
    warnings: [],
  };
  const configPath = path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(configPath)) return result;

  let active = false;
  let inMatchBlock = false;
  const text = fs.readFileSync(configPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseSshConfigLine(rawLine);
    if (!parsed) continue;
    const { key, value } = parsed;

    if (key === "host") {
      inMatchBlock = false;
      active = hostPatternListMatches(value, hostAlias);
      continue;
    }

    if (key === "match") {
      inMatchBlock = true;
      active = false;
      continue;
    }

    if (!active || inMatchBlock) continue;

    if (key === "hostname" && result.hostname === undefined) {
      result.hostname = value;
    } else if (key === "user" && result.user === undefined) {
      result.user = value;
    } else if (key === "port" && result.port === undefined) {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0) result.port = port;
    } else if (key === "identityfile") {
      result.identityFiles.push(value);
    } else if (key === "proxyjump" || key === "proxycommand") {
      result.warnings.push(`${key} in ~/.ssh/config is not supported by this tool and was ignored.`);
    }
  }

  return result;
}

function parseSshConfigLine(rawLine) {
  const line = stripSshConfigComment(rawLine).trim();
  if (!line) return null;
  const match = line.match(/^([A-Za-z][A-Za-z0-9]+)(?:\s+|=)(.*)$/);
  if (!match) return null;
  return {
    key: match[1].toLowerCase(),
    value: unquoteSshConfigValue(match[2].trim()),
  };
}

function stripSshConfigComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === "#" && quote === null && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquoteSshConfigValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function hostPatternListMatches(patternList, hostAlias) {
  const patterns = patternList.split(/\s+/).filter(Boolean);
  let matched = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const rawPattern = negative ? pattern.slice(1) : pattern;
    if (wildcardPatternMatches(rawPattern, hostAlias)) {
      if (negative) return false;
      matched = true;
    }
  }
  return matched;
}

function wildcardPatternMatches(pattern, value) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function firstUsableIdentityFile(identityFiles, tokens) {
  for (const identityFile of identityFiles ?? []) {
    if (identityFile.toLowerCase() === "none") continue;
    const expanded = expandOpenSshTokens(identityFile, tokens);
    const resolved = resolveLocalPath(expanded);
    if (fs.existsSync(resolved)) return resolved;
  }
  return undefined;
}

function expandOpenSshTokens(value, { alias, host, username, port }) {
  return value
    .replace(/%h/g, host || alias)
    .replace(/%n/g, alias)
    .replace(/%r/g, username)
    .replace(/%p/g, String(port));
}

function resolveAgent(agent) {
  if (typeof agent === "string" && agent.trim()) return expandHome(agent);
  if (agent === true && process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  return undefined;
}

function resolveLocalPath(localPath) {
  const expanded = expandHome(localPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function compareSha256Fingerprint(actual, expected) {
  const cleanExpected = normalizeFingerprint(expected);
  const actualValue = String(actual).trim();
  const variants = new Set([
    normalizeFingerprint(actualValue),
    normalizeFingerprint(`SHA256:${actualValue}`),
  ]);

  if (/^[0-9a-f]{64}$/i.test(actualValue)) {
    variants.add(Buffer.from(actualValue, "hex").toString("base64").replace(/=+$/, ""));
  }

  return variants.has(cleanExpected);
}

function normalizeFingerprint(value) {
  let text = String(value).trim();
  if (text.startsWith("SHA256:")) text = text.slice("SHA256:".length);
  text = text.replace(/\s+/g, "").replace(/=+$/, "");
  if (/^[0-9a-f:]{95}$/i.test(text)) return text.replace(/:/g, "").toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
  return text;
}

function posixDirname(remotePath) {
  const normalized = remotePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function assertString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string: ${name}`);
  }
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function maybeString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, min, max, fallback) {
  const number = Math.trunc(numberOrDefault(value, fallback));
  return Math.max(min, Math.min(max, number));
}

function sleep(ms) {
  const bounded = Math.max(0, Math.min(30_000, numberOrDefault(ms, 0)));
  return new Promise((resolve) => setTimeout(resolve, bounded));
}

function jsonText(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === undefined) return undefined;
    if (typeof item === "bigint") return item.toString();
    return item;
  }, 2);
}

function redactMessage(error, args) {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of ["password", "privateKey", "passphrase"]) {
    if (typeof args?.[key] === "string" && args[key]) {
      message = message.split(args[key]).join("[redacted]");
    }
  }
  return `Error: ${message}`;
}

function logError(label, error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[${SERVER_NAME}] ${label}: ${message}\n`);
}
