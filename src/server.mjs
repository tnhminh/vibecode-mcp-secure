import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
loadEnvFile(path.join(PROJECT_ROOT, '.env'));

const HOST = process.env.VIBECODE_HOST || '127.0.0.1';
const PORT = Number(process.env.VIBECODE_PORT || 7317);
const WORKSPACE = path.resolve(process.env.VIBECODE_WORKSPACE || process.cwd());
const CANONICAL_WORKSPACE = fs.existsSync(WORKSPACE) ? fs.realpathSync(WORKSPACE) : WORKSPACE;
const MAX_READ_BYTES = Number(process.env.VIBECODE_MAX_READ_BYTES || 262144);
const MAX_COMMAND_OUTPUT_BYTES = Number(process.env.VIBECODE_MAX_COMMAND_OUTPUT_BYTES || 262144);
const SHELL_MODE = process.env.VIBECODE_SHELL_MODE || 'allowlist';
const ALLOW_DANGEROUS = process.env.VIBECODE_ALLOW_DANGEROUS === '1';
const BROWSER_ALLOW_EXTERNAL = process.env.VIBECODE_BROWSER_ALLOW_EXTERNAL === '1';
const RUNTIME_DIR = path.join(PROJECT_ROOT, '.runtime');
const AUDIT_FILE = path.join(RUNTIME_DIR, 'audit.ndjson');
const ARTIFACT_DIR = path.join(WORKSPACE, '.vibecode-artifacts');
const TUNNEL_ID = process.env.CONTROL_PLANE_TUNNEL_ID || '';
const TUNNEL_ALIAS = process.env.TUNNEL_ALIAS || 'vibecode-local';
const TUNNEL_CLIENT = path.join(PROJECT_ROOT, 'bin', 'tunnel-client.exe');

await fsp.mkdir(RUNTIME_DIR, { recursive: true });
await fsp.mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});

const ignoredDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', '.venv', 'venv']);
const processRegistry = new Map();
let browserState = null;
const toolCounters = new Map();
let lastVerification = null;
let tunnelRuntime = {
  child: null,
  status: 'disconnected',
  tunnelId: TUNNEL_ID,
  alias: TUNNEL_ALIAS,
  lastMessage: 'Chưa có kết nối Tunnel nào được khởi chạy.',
  startedAt: null
};

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function asText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function audit(tool, args, status, extra = {}) {
  const record = {
    ts: new Date().toISOString(),
    tool,
    status,
    workspace: WORKSPACE,
    args: sanitizeArgs(args),
    ...extra
  };
  await fsp.appendFile(AUDIT_FILE, JSON.stringify(record) + os.EOL).catch(() => {});
}

function sanitizeArgs(args) {
  return sanitizeAuditValue(args, '');
}

function sanitizeAuditValue(value, key) {
  if (/key|token|secret|password|authorization/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (/content|replacement|replace|find|body/i.test(key)) return `[OMITTED ${Buffer.byteLength(value, 'utf8')} bytes]`;
    const redacted = value.replace(/(?:sk|rk|ghp|github_pat|token)[_-][A-Za-z0-9_-]{12,}/gi, '[REDACTED]');
    return redacted.length > 600 ? redacted.slice(0, 600) + '…' : redacted;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeAuditValue(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeAuditValue(childValue, childKey)]));
  }
  return value;
}

function isValidTunnelId(value) {
  return /^tunnel_[A-Za-z0-9_-]+$/.test(value) && !/REPLACE_ME|your-/i.test(value);
}

function redactTunnelOutput(value, runtimeApiKey = '') {
  let text = String(value || '');
  if (runtimeApiKey) text = text.replaceAll(runtimeApiKey, '[REDACTED]');
  return text.replace(/(?:sk|rk|key)[_-][A-Za-z0-9_-]{12,}/gi, '[REDACTED]').trim();
}

function tunnelSummary() {
  return {
    configured: isValidTunnelId(tunnelRuntime.tunnelId || TUNNEL_ID),
    alias: tunnelRuntime.alias || TUNNEL_ALIAS,
    clientInstalled: fs.existsSync(TUNNEL_CLIENT),
    runtimeStatus: tunnelRuntime.status,
    lastMessage: tunnelRuntime.lastMessage,
    startedAt: tunnelRuntime.startedAt
  };
}

function connectTunnel({ tunnelId, alias, runtimeApiKey }) {
  if (!isValidTunnelId(tunnelId)) throw new Error('Tunnel ID phải có dạng tunnel_...');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) throw new Error('Alias chỉ dùng chữ, số, dấu chấm, gạch dưới hoặc gạch nối.');
  if (!runtimeApiKey || !runtimeApiKey.trim()) throw new Error('Cần Runtime API key để kết nối Tunnel.');
  if (!fs.existsSync(TUNNEL_CLIENT)) throw new Error('Chưa có tunnel-client. Hãy chạy SETUP.cmd trước.');
  if (tunnelRuntime.child && !tunnelRuntime.child.killed) throw new Error('Một Tunnel đang được kết nối. Hãy ngắt kết nối trước khi tạo kết nối mới.');

  let secret = runtimeApiKey.trim();
  const child = spawn(TUNNEL_CLIENT, [
    'runtimes', 'connect', '--alias', alias, '--tunnel-id', tunnelId,
    '--runtime-api-key', 'env:CONTROL_PLANE_API_KEY', '--mcp-server-url', `http://${HOST}:${PORT}/mcp`
  ], {
    env: { ...process.env, CONTROL_PLANE_TUNNEL_ID: tunnelId, CONTROL_PLANE_API_KEY: secret },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  tunnelRuntime = {
    child,
    status: 'connecting',
    tunnelId,
    alias,
    lastMessage: 'Đang yêu cầu tunnel-client kết nối đến OpenAI Secure MCP Tunnel…',
    startedAt: new Date().toISOString()
  };

  const onOutput = chunk => {
    const message = redactTunnelOutput(chunk, secret);
    if (message) tunnelRuntime.lastMessage = message.slice(-600);
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', error => {
    tunnelRuntime.child = null;
    tunnelRuntime.status = 'failed';
    tunnelRuntime.lastMessage = redactTunnelOutput(error.message, secret) || 'Không thể chạy tunnel-client.';
    secret = '';
  });
  child.on('close', code => {
    tunnelRuntime.child = null;
    if (tunnelRuntime.status === 'disconnecting') {
      tunnelRuntime.status = 'disconnected';
      tunnelRuntime.lastMessage = 'Đã ngắt Tunnel.';
    } else if (code === 0) {
      tunnelRuntime.status = 'connected';
      tunnelRuntime.lastMessage = 'Tunnel-client đã hoàn tất yêu cầu kết nối.';
    } else {
      tunnelRuntime.status = 'failed';
      tunnelRuntime.lastMessage = `tunnel-client dừng với mã ${code}. ${tunnelRuntime.lastMessage}`.slice(-600);
    }
    secret = '';
  });

  return tunnelSummary();
}

function disconnectTunnel() {
  if (!fs.existsSync(TUNNEL_CLIENT)) throw new Error('Chưa có tunnel-client. Hãy chạy SETUP.cmd trước.');
  tunnelRuntime.status = 'disconnecting';
  tunnelRuntime.lastMessage = 'Đang ngắt Tunnel…';
  if (tunnelRuntime.child && !tunnelRuntime.child.killed) tunnelRuntime.child.kill();
  const stop = spawn(TUNNEL_CLIENT, ['runtimes', 'stop', tunnelRuntime.alias || TUNNEL_ALIAS], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  stop.stdout.on('data', chunk => output += redactTunnelOutput(chunk));
  stop.stderr.on('data', chunk => output += redactTunnelOutput(chunk));
  stop.on('error', error => {
    tunnelRuntime.status = 'failed';
    tunnelRuntime.lastMessage = redactTunnelOutput(error.message) || 'Không thể dừng Tunnel.';
  });
  stop.on('close', code => {
    tunnelRuntime.status = code === 0 ? 'disconnected' : 'failed';
    tunnelRuntime.lastMessage = code === 0 ? 'Đã ngắt Tunnel.' : (output.slice(-600) || `Không thể dừng Tunnel (mã ${code}).`);
  });
  return tunnelSummary();
}

function wrappedTool(name, fn) {
  return async (args = {}) => {
    const started = Date.now();
    toolCounters.set(name, (toolCounters.get(name) || 0) + 1);
    try {
      const data = await fn(args);
      await audit(name, args, 'success', { duration_ms: Date.now() - started });
      return { content: [{ type: 'text', text: asText(data) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error?.code || classifyError(message);
      await audit(name, args, 'failure', { duration_ms: Date.now() - started, error: { code, message } });
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: code, message }, null, 2) }]
      };
    }
  };
}

function classifyError(message) {
  if (/outside workspace/i.test(message)) return 'WORKSPACE_VIOLATION';
  if (/not found|ENOENT/i.test(message)) return 'FILE_NOT_FOUND';
  if (/permission|EACCES|EPERM/i.test(message)) return 'PERMISSION_DENIED';
  if (/timeout/i.test(message)) return 'COMMAND_TIMEOUT';
  if (/dangerous|blocked|allowlist/i.test(message)) return 'POLICY_DENIED';
  return 'TOOL_ERROR';
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalCandidatePath(candidate) {
  if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  let parent = path.dirname(candidate);
  while (parent !== path.dirname(parent) && !fs.existsSync(parent)) parent = path.dirname(parent);
  if (!fs.existsSync(parent)) return candidate;
  const canonicalParent = fs.realpathSync(parent);
  return path.resolve(canonicalParent, path.relative(parent, candidate));
}

function resolveWorkspacePath(input = '.') {
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(WORKSPACE, input);
  if (!isInsideRoot(WORKSPACE, candidate)) {
    const err = new Error(`Path is outside workspace: ${input}`);
    err.code = 'WORKSPACE_VIOLATION';
    throw err;
  }
  const canonical = canonicalCandidatePath(candidate);
  if (!isInsideRoot(CANONICAL_WORKSPACE, canonical)) {
    const err = new Error(`Path escapes workspace through symlink/junction: ${input}`);
    err.code = 'WORKSPACE_VIOLATION';
    throw err;
  }
  return candidate;
}

async function assertFileSize(file, max = MAX_READ_BYTES) {
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  if (stat.size > max) throw new Error(`File is ${stat.size} bytes; limit is ${max}. Use read_range or search_text.`);
  return stat;
}

function truncate(text, limit = MAX_COMMAND_OUTPUT_BYTES) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf8');
  return { text: buf.subarray(0, limit).toString('utf8') + '\n…[TRUNCATED]', truncated: true };
}

async function walk(dir, maxFiles = 1000, includeFiles = true) {
  const out = [];
  async function visit(current) {
    if (out.length >= maxFiles) return;
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (includeFiles && entry.isFile()) out.push(full);
    }
  }
  await visit(dir);
  return out;
}

async function buildTree(root, maxDepth = 4, maxEntries = 500) {
  let count = 0;
  const lines = [path.basename(root) + '/'];
  async function visit(dir, prefix, depth) {
    if (depth > maxDepth || count >= maxEntries) return;
    let entries = await fsp.readdir(dir, { withFileTypes: true });
    entries = entries.filter(e => !(e.isDirectory() && ignoredDirs.has(e.name))).sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < entries.length && count < maxEntries; i++) {
      const e = entries[i];
      const last = i === entries.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${e.isDirectory() ? '/' : ''}`);
      count++;
      if (e.isDirectory()) await visit(path.join(dir, e.name), prefix + (last ? '    ' : '│   '), depth + 1);
    }
  }
  await visit(root, '', 1);
  if (count >= maxEntries) lines.push(`… truncated at ${maxEntries} entries`);
  return lines.join('\n');
}

const dangerousPatterns = [
  /\bformat\b/i, /\bdiskpart\b/i, /\bbcdedit\b/i, /\bshutdown\b/i,
  /git\s+push\s+.*--force/i, /git\s+clean\s+-[^\s]*[xX]/i,
  /rm\s+-rf\s+\/$/i, /del\s+\/s\s+\/q\s+[a-z]:\\/i,
  /Remove-Item[^\n]*-[Rr]ecurse[^\n]*[A-Za-z]:\\/i, /reg\s+delete/i,
  /\bgit\s+config\s+--global\b/i
];
const allowedExecutables = new Set([
  'npm','npx','pnpm','yarn','bun','node','git','python','python3','py','pip','pip3','uv','pytest',
  'dotnet','go','cargo','rustc','tsc','eslint','prettier','vite','next','where','dir','type','echo',
  'java','javac','mvn','mvnw','gradle','gradlew','deno'
]);

function validateCommand(command) {
  if (!ALLOW_DANGEROUS && dangerousPatterns.some(r => r.test(command))) {
    throw Object.assign(new Error('Command blocked by dangerous-command policy.'), { code: 'POLICY_DENIED' });
  }
  if (SHELL_MODE === 'workspace-trusted') return;
  if (SHELL_MODE !== 'allowlist') throw new Error(`Unknown VIBECODE_SHELL_MODE=${SHELL_MODE}`);
  const segments = command.split(/&&|\|\||[;&|]/).map(s => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const first = segment.match(/^"?([^"\s]+)"?/i)?.[1] || '';
    const exe = path.basename(first).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
    if (!allowedExecutables.has(exe)) {
      throw Object.assign(new Error(`Command '${exe || first}' is not in the shell allowlist. Use filesystem tools or set VIBECODE_SHELL_MODE=workspace-trusted.`), { code: 'POLICY_DENIED' });
    }
  }
}

function shellSpec(command) {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  return { file: '/bin/sh', args: ['-lc', command] };
}

function runSpawn(file, args, cwd, timeoutMs = 120000, env = process.env) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { if (Buffer.byteLength(stdout) < MAX_COMMAND_OUTPUT_BYTES * 2) stdout += d.toString(); });
    child.stderr?.on('data', d => { if (Buffer.byteLength(stderr) < MAX_COMMAND_OUTPUT_BYTES * 2) stderr += d.toString(); });
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
      reject(Object.assign(new Error(`Command timed out after ${timeoutMs}ms`), { code: 'COMMAND_TIMEOUT' }));
    }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      const out = truncate(stdout);
      const err = truncate(stderr);
      resolve({ exitCode: code, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated, durationMs: Date.now() - started });
    });
  });
}

async function runCommand(command, cwd = '.', timeoutMs = 120000) {
  validateCommand(command);
  const resolvedCwd = resolveWorkspacePath(cwd);
  const spec = shellSpec(command);
  return runSpawn(spec.file, spec.args, resolvedCwd, timeoutMs);
}

async function git(args, cwd = '.', timeoutMs = 120000) {
  return runSpawn('git', args, resolveWorkspacePath(cwd), timeoutMs);
}

function quoteArg(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

async function runVerification(cwd = '.', timeoutMsPerStep = 180000) {
  const startedAt = new Date().toISOString();
  const root = resolveWorkspacePath(cwd);
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error('verify_project currently expects package.json in cwd.');
  const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
  const scripts = pkg.scripts || {};
  const names = ['lint', 'typecheck', 'check', 'test', 'build'];
  const results = [];
  for (const name of names) {
    if (!scripts[name]) continue;
    const result = await runCommand(`npm run ${name}`, cwd, timeoutMsPerStep);
    results.push({ step: name, ok: result.exitCode === 0, ...result });
    if (result.exitCode !== 0) break;
  }
  lastVerification = {
    ok: results.length > 0 && results.every(r => r.ok),
    steps: results,
    skipped: names.filter(n => !scripts[n]),
    startedAt,
    finishedAt: new Date().toISOString()
  };
  return lastVerification;
}

async function readAuditEvents(limit = 60) {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  const lines = (await fsp.readFile(AUDIT_FILE, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map(line => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}

function processSnapshot() {
  const items = [...processRegistry.values()].map(p => ({
    id: p.id,
    pid: p.child.pid,
    command: p.command,
    cwd: p.cwd,
    status: p.status,
    exitCode: p.exitCode,
    logLines: p.logs.length
  }));
  return {
    items,
    running: items.filter(p => p.status === 'running').length,
    exited: items.filter(p => p.status === 'exited').length,
    failed: items.filter(p => p.status === 'error' || (p.status === 'exited' && p.exitCode && p.exitCode !== 0)).length
  };
}

async function gitDashboardSummary() {
  const status = await git(['status', '--short', '--branch']);
  if (status.exitCode !== 0) return { available: false, error: (status.stderr || status.stdout || 'Not a Git repository').trim() };
  const lines = status.stdout.trim().split(/\r?\n/).filter(Boolean);
  const headLine = lines[0] || '## unknown';
  const head = headLine.replace(/^##\s*/, '');
  const branch = head.split('...')[0].split(' ')[0] || 'unknown';
  const changes = lines.slice(1);
  const latest = await git(['log', '-1', '--pretty=format:%h|%s|%cI']);
  const origin = await git(['remote', 'get-url', 'origin']);
  let commit = null;
  if (latest.exitCode === 0 && latest.stdout.trim()) {
    const [hash, subject, committedAt] = latest.stdout.trim().split('|');
    commit = { hash, subject, committedAt };
  }
  return {
    available: true,
    branch,
    tracking: head.includes('...') ? head.split('...')[1].split(' ')[0] : null,
    clean: changes.length === 0,
    changedFiles: changes.length,
    changes: changes.slice(0, 20),
    origin: origin.exitCode === 0 ? origin.stdout.trim() : null,
    commit
  };
}

function securityDashboardSummary() {
  const warnings = [];
  const critical = [];
  if (HOST !== '127.0.0.1') critical.push('MCP listener không bind vào loopback.');
  if (ALLOW_DANGEROUS) critical.push('Dangerous command mode đang được bật.');
  if (SHELL_MODE === 'workspace-trusted') warnings.push('Shell đang ở workspace-trusted; repository scripts có quyền của Windows account.');
  if (BROWSER_ALLOW_EXTERNAL) warnings.push('Browser được phép điều hướng ra host bên ngoài.');
  warnings.push('Granular project permission engine chưa được triển khai.');
  return {
    level: critical.length ? 'danger' : warnings.length ? 'warning' : 'ok',
    critical,
    warnings,
    protections: [
      { label: 'MCP listener', value: HOST, ok: HOST === '127.0.0.1' },
      { label: 'Workspace boundary', value: 'canonical', ok: true },
      { label: 'Shell policy', value: SHELL_MODE, ok: SHELL_MODE === 'allowlist' },
      { label: 'Dangerous commands', value: ALLOW_DANGEROUS ? 'allowed' : 'blocked', ok: !ALLOW_DANGEROUS },
      { label: 'External browser', value: BROWSER_ALLOW_EXTERNAL ? 'allowed' : 'blocked', ok: !BROWSER_ALLOW_EXTERNAL },
      { label: 'Audit logging', value: 'enabled', ok: true }
    ]
  };
}

async function browserDashboardSummary() {
  if (!browserState) return { active: false, url: null, title: null, consoleErrors: 0, networkErrors: 0 };
  return {
    active: true,
    url: browserState.page.url(),
    title: await browserState.page.title().catch(() => ''),
    consoleErrors: browserState.console.filter(x => x.type === 'error').length,
    networkErrors: browserState.networkErrors.length
  };
}

async function dashboardPayload() {
  const [gitState, activity, browser] = await Promise.all([
    gitDashboardSummary(),
    readAuditEvents(60),
    browserDashboardSummary()
  ]);
  const processes = processSnapshot();
  const security = securityDashboardSummary();
  const success = activity.filter(x => x.status === 'success').length;
  const failures = activity.filter(x => x.status === 'failure').length;
  const durations = activity.map(x => Number(x.duration_ms)).filter(Number.isFinite);
  const lastError = [...activity].reverse().find(x => x.status === 'failure') || null;
  const packageInfo = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'));
      return { name: pkg.name || path.basename(WORKSPACE), version: pkg.version || null };
    } catch {
      return { name: path.basename(WORKSPACE), version: null };
    }
  })();
  const tunnel = tunnelSummary();
  const workspaceReady = fs.existsSync(WORKSPACE);
  const overall = !workspaceReady
    ? 'down'
    : security.level === 'danger'
      ? 'degraded'
      : tunnel.runtimeStatus === 'connected'
        ? security.level === 'warning' ? 'attention' : 'healthy'
        : 'setup';
  return {
    service: 'vibecode-mcp-secure',
    version: '0.1.0',
    workspace: WORKSPACE,
    package: packageInfo,
    runtime: { node: process.version, platform: process.platform, host: HOST, port: PORT },
    shellMode: SHELL_MODE,
    toolsCalled: Object.fromEntries(toolCounters),
    processes,
    tunnel,
    git: gitState,
    verification: lastVerification,
    browser,
    security,
    activity: {
      items: activity.slice(-20).reverse(),
      total: activity.length,
      success,
      failures,
      avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      lastError
    },
    readiness: { workspaceReady, overall }
  };
}

function registerTools(server) {
  server.registerTool('health', {
    description: 'Return Vibecode MCP health, workspace, policies, and runtime summary.',
    inputSchema: z.object({})
  }, wrappedTool('health', async () => ({
    ok: true,
    version: '0.1.0',
    workspace: WORKSPACE,
    host: HOST,
    port: PORT,
    shellMode: SHELL_MODE,
    browserExternalAllowed: BROWSER_ALLOW_EXTERNAL,
    processes: [...processRegistry.values()].map(p => ({ id: p.id, pid: p.child.pid, command: p.command, status: p.status })),
    toolsCalled: Object.fromEntries(toolCounters)
  })));

  server.registerTool('project_info', {
    description: 'Summarize the active workspace, package metadata, Git state, and top-level files.',
    inputSchema: z.object({})
  }, wrappedTool('project_info', async () => {
    const result = { workspace: WORKSPACE, exists: fs.existsSync(WORKSPACE), platform: process.platform };
    try { result.topLevel = (await fsp.readdir(WORKSPACE)).slice(0, 100); } catch {}
    try { result.package = JSON.parse(await fsp.readFile(path.join(WORKSPACE, 'package.json'), 'utf8')); } catch {}
    try { result.git = await git(['status', '--short', '--branch']); } catch {}
    return result;
  }));

  server.registerTool('tree', {
    description: 'Return a compact directory tree under the workspace.',
    inputSchema: z.object({ path: z.string().default('.'), maxDepth: z.number().int().min(1).max(10).default(4), maxEntries: z.number().int().min(10).max(3000).default(500) })
  }, wrappedTool('tree', async ({ path: p = '.', maxDepth = 4, maxEntries = 500 }) => buildTree(resolveWorkspacePath(p), maxDepth, maxEntries)));

  server.registerTool('read_file', {
    description: 'Read a UTF-8 text file inside the workspace, subject to size limits.',
    inputSchema: z.object({ path: z.string() })
  }, wrappedTool('read_file', async ({ path: p }) => {
    const file = resolveWorkspacePath(p);
    await assertFileSize(file);
    return { path: file, content: await fsp.readFile(file, 'utf8') };
  }));

  server.registerTool('read_range', {
    description: 'Read a 1-based inclusive line range from a text file.',
    inputSchema: z.object({ path: z.string(), startLine: z.number().int().min(1), endLine: z.number().int().min(1) })
  }, wrappedTool('read_range', async ({ path: p, startLine, endLine }) => {
    if (endLine < startLine || endLine - startLine > 2000) throw new Error('Invalid or too-large line range (max 2001 lines).');
    const file = resolveWorkspacePath(p);
    const text = await fsp.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    return { path: file, startLine, endLine: Math.min(endLine, lines.length), content: lines.slice(startLine - 1, endLine).map((line, i) => `${startLine + i}: ${line}`).join('\n') };
  }));

  server.registerTool('write_file', {
    description: 'Write a UTF-8 file inside the workspace. Parent directories are created automatically.',
    inputSchema: z.object({ path: z.string(), content: z.string(), overwrite: z.boolean().default(true) })
  }, wrappedTool('write_file', async ({ path: p, content, overwrite = true }) => {
    const file = resolveWorkspacePath(p);
    if (!overwrite && fs.existsSync(file)) throw new Error(`File already exists: ${p}`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.vibecode-${randomUUID()}.tmp`;
    await fsp.writeFile(temp, content, 'utf8');
    try { await fsp.rename(temp, file); } catch { await fsp.copyFile(temp, file); await fsp.rm(temp, { force: true }); }
    return { path: file, bytes: Buffer.byteLength(content, 'utf8') };
  }));

  server.registerTool('apply_patch', {
    description: 'Apply deterministic exact-text edits to one file. Each edit must match expectedOccurrences exactly.',
    inputSchema: z.object({
      path: z.string(),
      edits: z.array(z.object({ find: z.string().min(1), replace: z.string(), expectedOccurrences: z.number().int().min(1).max(100).default(1) })).min(1).max(50)
    })
  }, wrappedTool('apply_patch', async ({ path: p, edits }) => {
    const file = resolveWorkspacePath(p);
    let text = await fsp.readFile(file, 'utf8');
    const applied = [];
    for (const edit of edits) {
      const count = text.split(edit.find).length - 1;
      if (count !== edit.expectedOccurrences) throw Object.assign(new Error(`PATCH_CONFLICT: expected ${edit.expectedOccurrences} occurrence(s), found ${count}.`), { code: 'PATCH_CONFLICT' });
      text = text.split(edit.find).join(edit.replace);
      applied.push({ expectedOccurrences: edit.expectedOccurrences, findPreview: edit.find.slice(0, 120) });
    }
    await fsp.writeFile(file, text, 'utf8');
    return { path: file, applied };
  }));

  server.registerTool('delete_path', {
    description: 'Delete a file or directory inside workspace. Requires confirm=true.',
    inputSchema: z.object({ path: z.string(), recursive: z.boolean().default(false), confirm: z.literal(true) })
  }, wrappedTool('delete_path', async ({ path: p, recursive = false }) => {
    const target = resolveWorkspacePath(p);
    if (target === WORKSPACE) throw new Error('Refusing to delete workspace root.');
    await fsp.rm(target, { recursive, force: false });
    return { deleted: target };
  }));

  server.registerTool('search_text', {
    description: 'Search UTF-8-ish files recursively using a literal string or regular expression.',
    inputSchema: z.object({ query: z.string().min(1), path: z.string().default('.'), regex: z.boolean().default(false), caseSensitive: z.boolean().default(false), maxResults: z.number().int().min(1).max(500).default(100) })
  }, wrappedTool('search_text', async ({ query, path: p = '.', regex = false, caseSensitive = false, maxResults = 100 }) => {
    const root = resolveWorkspacePath(p);
    const files = await walk(root, 3000);
    const flags = caseSensitive ? 'g' : 'gi';
    const re = regex ? new RegExp(query, flags) : null;
    const needle = caseSensitive ? query : query.toLowerCase();
    const results = [];
    for (const file of files) {
      if (results.length >= maxResults) break;
      let stat; try { stat = await fsp.stat(file); } catch { continue; }
      if (stat.size > 1024 * 1024) continue;
      let text; try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
      if (text.includes('\u0000')) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
        let match = false;
        if (re) { re.lastIndex = 0; match = re.test(lines[i]); } else match = hay.includes(needle);
        if (match) results.push({ file: path.relative(WORKSPACE, file), line: i + 1, text: lines[i].slice(0, 500) });
      }
    }
    return { query, count: results.length, results };
  }));

  server.registerTool('repo_map', {
    description: 'Generate a compact repository map with tree, package scripts, Git branch and likely entry points.',
    inputSchema: z.object({ maxDepth: z.number().int().min(1).max(8).default(4) })
  }, wrappedTool('repo_map', async ({ maxDepth = 4 }) => {
    let pkg = null;
    try { pkg = JSON.parse(await fsp.readFile(path.join(WORKSPACE, 'package.json'), 'utf8')); } catch {}
    let gitState = null;
    try { gitState = await git(['status', '--short', '--branch']); } catch {}
    const candidates = ['src','app','pages','server','api','lib','components','tests','test','scripts'].filter(x => fs.existsSync(path.join(WORKSPACE, x)));
    return { workspace: WORKSPACE, tree: await buildTree(WORKSPACE, maxDepth, 800), package: pkg ? { name: pkg.name, scripts: pkg.scripts, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies } : null, git: gitState, likelyRoots: candidates };
  }));

  server.registerTool('run_command', {
    description: 'Run a command in a workspace-relative cwd. Default policy is a coding-oriented executable allowlist.',
    inputSchema: z.object({ command: z.string().min(1), cwd: z.string().default('.'), timeoutMs: z.number().int().min(1000).max(600000).default(120000) })
  }, wrappedTool('run_command', async ({ command, cwd = '.', timeoutMs = 120000 }) => runCommand(command, cwd, timeoutMs)));

  server.registerTool('start_process', {
    description: 'Start a long-running development process without blocking MCP.',
    inputSchema: z.object({ command: z.string().min(1), cwd: z.string().default('.') })
  }, wrappedTool('start_process', async ({ command, cwd = '.' }) => {
    validateCommand(command);
    const resolvedCwd = resolveWorkspacePath(cwd);
    const spec = shellSpec(command);
    const child = spawn(spec.file, spec.args, { cwd: resolvedCwd, env: process.env, windowsHide: true });
    const id = `proc_${randomUUID().slice(0, 8)}`;
    const record = { id, child, command, cwd: resolvedCwd, status: 'running', exitCode: null, logs: [] };
    const add = (stream, d) => { record.logs.push({ ts: new Date().toISOString(), stream, text: d.toString() }); if (record.logs.length > 500) record.logs.splice(0, record.logs.length - 500); };
    child.stdout?.on('data', d => add('stdout', d));
    child.stderr?.on('data', d => add('stderr', d));
    child.on('close', code => { record.status = 'exited'; record.exitCode = code; });
    child.on('error', err => { record.status = 'error'; add('error', Buffer.from(err.message)); });
    processRegistry.set(id, record);
    return { id, pid: child.pid, command, cwd: resolvedCwd };
  }));

  server.registerTool('process_list', {
    description: 'List processes started by this MCP runtime.', inputSchema: z.object({})
  }, wrappedTool('process_list', async () => [...processRegistry.values()].map(p => ({ id: p.id, pid: p.child.pid, command: p.command, cwd: p.cwd, status: p.status, exitCode: p.exitCode }))));

  server.registerTool('process_logs', {
    description: 'Read recent logs from a process started by this MCP runtime.',
    inputSchema: z.object({ id: z.string(), tail: z.number().int().min(1).max(500).default(100) })
  }, wrappedTool('process_logs', async ({ id, tail = 100 }) => {
    const p = processRegistry.get(id); if (!p) throw new Error(`Unknown process id: ${id}`);
    return { id, status: p.status, logs: p.logs.slice(-tail) };
  }));

  server.registerTool('stop_process', {
    description: 'Stop a process previously started by start_process.', inputSchema: z.object({ id: z.string(), force: z.boolean().default(false) })
  }, wrappedTool('stop_process', async ({ id, force = false }) => {
    const p = processRegistry.get(id); if (!p) throw new Error(`Unknown process id: ${id}`);
    if (p.status !== 'running') return { id, status: p.status, exitCode: p.exitCode };
    if (process.platform === 'win32') await runSpawn('taskkill', force ? ['/PID', String(p.child.pid), '/T', '/F'] : ['/PID', String(p.child.pid), '/T'], WORKSPACE, 15000).catch(() => p.child.kill());
    else p.child.kill(force ? 'SIGKILL' : 'SIGTERM');
    return { id, stopped: true };
  }));

  server.registerTool('git_status', { description: 'Show Git status.', inputSchema: z.object({ cwd: z.string().default('.') }) }, wrappedTool('git_status', async ({ cwd = '.' }) => git(['status', '--short', '--branch'], cwd)));
  server.registerTool('git_diff', { description: 'Show Git diff.', inputSchema: z.object({ cwd: z.string().default('.'), staged: z.boolean().default(false) }) }, wrappedTool('git_diff', async ({ cwd = '.', staged = false }) => git(staged ? ['diff', '--cached'] : ['diff'], cwd)));
  server.registerTool('git_log', { description: 'Show recent Git commits.', inputSchema: z.object({ cwd: z.string().default('.'), limit: z.number().int().min(1).max(100).default(20) }) }, wrappedTool('git_log', async ({ cwd = '.', limit = 20 }) => git(['log', `-${limit}`, '--oneline', '--decorate'], cwd)));
  server.registerTool('git_add', { description: 'Stage paths in Git.', inputSchema: z.object({ paths: z.array(z.string()).min(1).max(100), cwd: z.string().default('.') }) }, wrappedTool('git_add', async ({ paths, cwd = '.' }) => git(['add', '--', ...paths], cwd)));
  server.registerTool('git_commit', { description: 'Create a Git commit from staged changes.', inputSchema: z.object({ message: z.string().min(1).max(500), cwd: z.string().default('.') }) }, wrappedTool('git_commit', async ({ message, cwd = '.' }) => git(['commit', '-m', message], cwd)));
  server.registerTool('git_restore', { description: 'Restore working-tree paths. Destructive; requires confirm=true.', inputSchema: z.object({ paths: z.array(z.string()).min(1), staged: z.boolean().default(false), cwd: z.string().default('.'), confirm: z.literal(true) }) }, wrappedTool('git_restore', async ({ paths, staged = false, cwd = '.' }) => git(staged ? ['restore', '--staged', '--', ...paths] : ['restore', '--', ...paths], cwd)));

  server.registerTool('verify_project', {
    description: 'Run available lint/typecheck/test/build package scripts in sequence and summarize results.',
    inputSchema: z.object({ cwd: z.string().default('.'), timeoutMsPerStep: z.number().int().min(5000).max(600000).default(180000) })
  }, wrappedTool('verify_project', async ({ cwd = '.', timeoutMsPerStep = 180000 }) => runVerification(cwd, timeoutMsPerStep)));

  server.registerTool('audit_tail', {
    description: 'Read recent MCP audit events.', inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(100) })
  }, wrappedTool('audit_tail', async ({ limit = 100 }) => {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const lines = (await fsp.readFile(AUDIT_FILE, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
  }));

  server.registerTool('browser_open', {
    description: 'Open a URL in a headless Chromium page. External hosts are blocked by default.', inputSchema: z.object({ url: z.string().url() })
  }, wrappedTool('browser_open', async ({ url }) => {
    const state = await ensureBrowser();
    validateBrowserUrl(url);
    const response = await state.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { url: state.page.url(), title: await state.page.title(), status: response?.status() ?? null };
  }));

  server.registerTool('browser_click', {
    description: 'Click an element using a Playwright selector.', inputSchema: z.object({ selector: z.string().min(1) })
  }, wrappedTool('browser_click', async ({ selector }) => { const s = await ensureBrowser(); await s.page.locator(selector).first().click({ timeout: 15000 }); return { url: s.page.url(), title: await s.page.title() }; }));

  server.registerTool('browser_fill', {
    description: 'Fill an input using a Playwright selector.', inputSchema: z.object({ selector: z.string().min(1), value: z.string() })
  }, wrappedTool('browser_fill', async ({ selector, value }) => { const s = await ensureBrowser(); await s.page.locator(selector).first().fill(value, { timeout: 15000 }); return { ok: true }; }));

  server.registerTool('browser_snapshot', {
    description: 'Return current page URL/title/body text plus recent console/network errors.', inputSchema: z.object({ maxChars: z.number().int().min(1000).max(50000).default(12000) })
  }, wrappedTool('browser_snapshot', async ({ maxChars = 12000 }) => { const s = await ensureBrowser(); const body = (await s.page.locator('body').innerText().catch(() => '')).slice(0, maxChars); return { url: s.page.url(), title: await s.page.title(), bodyText: body, console: s.console.slice(-50), networkErrors: s.networkErrors.slice(-50) }; }));

  server.registerTool('browser_screenshot', {
    description: 'Save a screenshot under .vibecode-artifacts and return its workspace-relative path.', inputSchema: z.object({ name: z.string().regex(/^[A-Za-z0-9._-]+$/).default('screenshot.png'), fullPage: z.boolean().default(true) })
  }, wrappedTool('browser_screenshot', async ({ name = 'screenshot.png', fullPage = true }) => { const s = await ensureBrowser(); const filename = name.toLowerCase().endsWith('.png') ? name : `${name}.png`; const file = path.join(ARTIFACT_DIR, filename); await s.page.screenshot({ path: file, fullPage }); return { path: path.relative(WORKSPACE, file) }; }));

  server.registerTool('browser_close', { description: 'Close the headless browser session.', inputSchema: z.object({}) }, wrappedTool('browser_close', async () => { if (browserState) { await browserState.browser.close(); browserState = null; } return { closed: true }; }));
}

function validateBrowserUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https browser URLs are allowed.');
  if (BROWSER_ALLOW_EXTERNAL) return;
  const local = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!local.has(u.hostname)) throw Object.assign(new Error(`External browser host blocked: ${u.hostname}`), { code: 'POLICY_DENIED' });
}

async function ensureBrowser() {
  if (browserState) return browserState;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const state = { browser, page, console: [], networkErrors: [] };
  page.on('console', msg => { state.console.push({ type: msg.type(), text: msg.text() }); if (state.console.length > 200) state.console.shift(); });
  page.on('response', res => { if (res.status() >= 400) { state.networkErrors.push({ status: res.status(), url: res.url() }); if (state.networkErrors.length > 200) state.networkErrors.shift(); } });
  page.on('requestfailed', req => { state.networkErrors.push({ status: 'FAILED', url: req.url(), error: req.failure()?.errorText }); if (state.networkErrors.length > 200) state.networkErrors.shift(); });
  browserState = state;
  return state;
}

function buildMcpServer() {
  const server = new McpServer({ name: 'vibecode-mcp-secure', version: '0.1.0' });
  registerTools(server);
  return server;
}

const app = createMcpExpressApp();
const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);
// createMcpExpressApp() parses JSON before this route. Pass that parsed body
// through so the Node adapter does not attempt to read an already-consumed stream.
app.all('/mcp', (req, res) => nodeMcpHandler(req, res, req.body));

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'vibecode-mcp-secure', workspace: WORKSPACE }));
app.get('/readyz', async (_req, res) => {
  const workspaceExists = fs.existsSync(WORKSPACE);
  res.status(workspaceExists ? 200 : 503).json({ ready: workspaceExists, workspace: WORKSPACE, reason: workspaceExists ? undefined : 'workspace_not_found' });
});
app.get('/api/status', async (_req, res) => {
  try { res.json(await dashboardPayload()); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
app.get('/api/git/diff', async (_req, res) => {
  const result = await git(['diff']);
  res.status(result.exitCode === 0 ? 200 : 400).json(result);
});
app.get('/api/process/:id/logs', (req, res) => {
  const p = processRegistry.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Unknown process id.' });
  res.json({ ok: true, id: p.id, status: p.status, logs: p.logs.slice(-200) });
});
app.post('/api/process/:id/stop', async (req, res) => {
  const p = processRegistry.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Unknown process id.' });
  if (p.status !== 'running') return res.json({ ok: true, id: p.id, status: p.status, exitCode: p.exitCode });
  try {
    if (process.platform === 'win32') await runSpawn('taskkill', ['/PID', String(p.child.pid), '/T'], WORKSPACE, 15000).catch(() => p.child.kill());
    else p.child.kill('SIGTERM');
    res.json({ ok: true, id: p.id, stopped: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
app.post('/api/verify', async (_req, res) => {
  try { res.json({ ok: true, verification: await runVerification('.', 180000) }); }
  catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
app.post('/api/tunnel/connect', (req, res) => {
  try {
    const tunnelId = String(req.body?.tunnelId || '').trim();
    const alias = String(req.body?.alias || TUNNEL_ALIAS).trim();
    const runtimeApiKey = String(req.body?.runtimeApiKey || '');
    const tunnel = connectTunnel({ tunnelId, alias, runtimeApiKey });
    res.status(202).json({ ok: true, tunnel });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
app.post('/api/tunnel/disconnect', (_req, res) => {
  try { res.json({ ok: true, tunnel: disconnectTunnel() }); }
  catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
app.get('/', async (_req, res) => {
  try { res.type('html').send(await fsp.readFile(path.join(PROJECT_ROOT, 'src', 'control-center.html'), 'utf8')); }
  catch (error) { res.status(500).type('text').send(error instanceof Error ? error.message : String(error)); }
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`[vibecode-mcp] listening on http://${HOST}:${PORT}`);
  console.log(`[vibecode-mcp] MCP endpoint http://${HOST}:${PORT}/mcp`);
  console.log(`[vibecode-mcp] workspace ${WORKSPACE}`);
  console.log(`[vibecode-mcp] shell mode ${SHELL_MODE}`);
});

async function shutdown(signal) {
  console.log(`[vibecode-mcp] ${signal}: shutting down`);
  for (const p of processRegistry.values()) {
    if (p.status === 'running') {
      try { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(p.child.pid), '/T', '/F'], { windowsHide: true }); else p.child.kill('SIGTERM'); } catch {}
    }
  }
  if (browserState) { try { await browserState.browser.close(); } catch {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
