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
  if (!args || typeof args !== 'object') return args;
  const clone = structuredClone(args);
  for (const key of Object.keys(clone)) {
    if (/key|token|secret|password|authorization/i.test(key)) clone[key] = '[REDACTED]';
    if (typeof clone[key] === 'string' && clone[key].length > 1200) clone[key] = clone[key].slice(0, 1200) + '…';
  }
  return clone;
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

function resolveWorkspacePath(input = '.') {
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(WORKSPACE, input);
  const relative = path.relative(WORKSPACE, candidate);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) return candidate;
  const err = new Error(`Path is outside workspace: ${input}`);
  err.code = 'WORKSPACE_VIOLATION';
  throw err;
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
  const segments = command.split(/&&|\|\||[;|]/).map(s => s.trim()).filter(Boolean);
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
  }, wrappedTool('verify_project', async ({ cwd = '.', timeoutMsPerStep = 180000 }) => {
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
    return { ok: results.length > 0 && results.every(r => r.ok), steps: results, skipped: names.filter(n => !scripts[n]) };
  }));

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
function statusPayload() {
  return {
    service: 'vibecode-mcp-secure', version: '0.1.0', workspace: WORKSPACE, shellMode: SHELL_MODE,
    toolsCalled: Object.fromEntries(toolCounters),
    processes: [...processRegistry.values()].map(p => ({ id: p.id, pid: p.child.pid, command: p.command, status: p.status, exitCode: p.exitCode })),
    tunnel: tunnelSummary()
  };
}

app.get('/api/status', (_req, res) => res.json(statusPayload()));
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
app.get('/', (_req, res) => res.type('html').send(renderControlCenter(statusPayload())));

function renderControlCenter(status) {
  const endpoint = `http://${HOST}:${PORT}/mcp`;
  const setupReady = status.tunnel.configured && status.tunnel.clientInstalled;
  const nextAction = !status.tunnel.configured
    ? 'Nhập Tunnel ID và Runtime API key ở phần Kết nối Tunnel.'
    : !status.tunnel.clientInstalled
      ? 'Chạy SETUP.cmd để cài tunnel-client.'
      : 'Kết nối Tunnel ở đây, rồi thêm connector trong ChatGPT.';
  const connectionLabel = setupReady ? 'Sẵn sàng đấu nối' : 'Chưa hoàn tất cấu hình';
  const connectionClass = setupReady ? 'ready' : 'pending';
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Vibecode MCP · Control Center</title>
  <style>
    :root{--ink:#16213a;--muted:#667085;--line:#e6eaf0;--surface:#fff;--canvas:#f6f8fc;--blue:#315efb;--blue-dark:#2347c7;--green:#147a53;--green-bg:#e9f9f1;--amber:#a65800;--amber-bg:#fff5e6;--shadow:0 18px 55px rgba(25,45,85,.09)}
    *{box-sizing:border-box} body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    .wrap{max-width:1180px;margin:auto;padding:30px 22px 56px}.top{display:flex;justify-content:space-between;gap:22px;align-items:flex-start;margin-bottom:25px}.brand{display:flex;gap:13px;align-items:center}.mark{display:grid;place-items:center;width:43px;height:43px;border-radius:13px;background:linear-gradient(135deg,#315efb,#6948ed);color:#fff;font-weight:800;font-size:18px;box-shadow:0 8px 18px #315efb44}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-weight:750;font-size:11px;color:var(--blue);margin:0 0 2px}.top h1{font-size:25px;line-height:1.1;margin:0;letter-spacing:-.03em}.top p{margin:7px 0 0;color:var(--muted)}
    .badge{white-space:nowrap;display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #bfe9d5;background:var(--green-bg);border-radius:999px;color:var(--green);font-weight:700}.dot{width:8px;height:8px;border-radius:99px;background:#1ca66f;box-shadow:0 0 0 4px #1ca66f20}
    .hero{background:linear-gradient(120deg,#152958,#253e92 58%,#315efb);border-radius:22px;color:#fff;padding:31px 33px;box-shadow:var(--shadow);display:flex;justify-content:space-between;gap:25px;align-items:center}.hero h2{font-size:25px;letter-spacing:-.025em;line-height:1.18;margin:0 0 9px}.hero p{margin:0;color:#dce7ff;max-width:630px}.next{background:#ffffff18;border:1px solid #ffffff28;border-radius:13px;padding:13px 15px;min-width:250px;font-size:13px}.next strong{display:block;margin-bottom:3px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#adc7ff}
    .grid{display:grid;grid-template-columns:1.35fr .85fr;gap:20px;margin-top:20px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:24px;box-shadow:0 3px 12px rgba(32,55,90,.025)}.panel h2{font-size:18px;letter-spacing:-.015em;margin:0}.panel .sub{color:var(--muted);margin:5px 0 20px}
    .status-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric{padding:15px;border:1px solid var(--line);border-radius:13px;background:#fbfcfe}.metric .label{display:block;font-size:12px;color:var(--muted);margin-bottom:7px}.metric .value{font-weight:750;font-size:14px;word-break:break-word}.online{color:var(--green)}.mono{font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
    .endpoint{display:flex;align-items:center;gap:8px;margin-top:17px;border:1px solid #dbe4ff;background:#f3f6ff;border-radius:13px;padding:11px 12px}.endpoint code{color:#1c3fa5;overflow:auto;white-space:nowrap;flex:1}.copy{border:0;border-radius:9px;background:#fff;color:var(--blue);font-weight:700;cursor:pointer;padding:7px 10px;box-shadow:0 1px 4px #264fa822}.copy:hover{background:#e9efff}
    .connection{margin-top:19px;border-radius:13px;padding:13px 14px;display:flex;gap:10px;align-items:flex-start}.connection.ready{background:var(--green-bg);color:#125f42}.connection.pending{background:var(--amber-bg);color:#874600}.connection b{display:block}.connection p{margin:2px 0 0;font-size:13px}
    .form{display:grid;gap:14px}.field{display:grid;gap:6px}.field label{font-weight:700;font-size:13px}.field input{width:100%;border:1px solid #cfd7e6;border-radius:10px;padding:10px 11px;font:14px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--ink);outline:none}.field input:focus{border-color:var(--blue);box-shadow:0 0 0 3px #315efb18}.field small{color:var(--muted);font-size:12px}.actions{display:flex;gap:9px;align-items:center;margin-top:3px}.primary,.secondary{border:0;border-radius:10px;padding:10px 13px;font-weight:750;cursor:pointer}.primary{background:var(--blue);color:#fff}.primary:hover{background:var(--blue-dark)}.primary:disabled{opacity:.58;cursor:wait}.secondary{background:#eef2ff;color:#274bb5}.result{display:none;margin-top:15px;padding:12px 13px;border-radius:10px;font-size:13px}.result.show{display:block}.result.success{background:var(--green-bg);color:#125f42}.result.error{background:#fff0ef;color:#a13227}.hint{margin-top:19px;padding:14px 15px;border-radius:12px;background:#f6f8fc;color:#536076;font-size:13px}.hint b{color:var(--ink)}
    .details{margin-top:20px}.details summary{cursor:pointer;color:#536076;font-weight:650}.details ul{padding-left:19px;color:var(--muted);font-size:13px}.links{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}.link{display:inline-flex;align-items:center;gap:5px;padding:7px 10px;border:1px solid var(--line);border-radius:9px;color:#40506e;text-decoration:none;font-size:13px;font-weight:650}.link:hover{border-color:#afc2ff;color:var(--blue)}
    @media(max-width:800px){.top,.hero{display:block}.badge{margin-top:15px;width:max-content}.hero{padding:25px}.next{margin-top:17px}.grid{grid-template-columns:1fr}.status-cards{grid-template-columns:1fr}.wrap{padding:20px 14px 40px}}
  </style>
</head>
<body>
  <main class="wrap">
    <header class="top">
      <div class="brand"><div class="mark">V</div><div><p class="eyebrow">Local-first MCP</p><h1>Vibecode Control Center</h1><p>Trung tâm vận hành MCP trên máy của bạn.</p></div></div>
      <div class="badge"><i class="dot"></i>Server đang hoạt động</div>
    </header>
    <section class="hero"><div><h2>Máy chủ đã sẵn sàng.</h2><p>Hoàn tất ba bước dưới đây để ChatGPT có thể sử dụng workspace cục bộ này qua OpenAI Secure MCP Tunnel.</p></div><div class="next"><strong>Bước tiếp theo</strong>${escapeHtml(nextAction)}</div></section>
    <div class="grid">
      <section class="panel"><h2>Trạng thái hiện tại</h2><p class="sub">Dịch vụ chỉ lắng nghe trên máy này — không được public ra Internet.</p>
        <div class="status-cards"><div class="metric"><span class="label">MCP server</span><span class="value online">● Đang hoạt động</span></div><div class="metric"><span class="label">Workspace</span><span class="value mono">${escapeHtml(WORKSPACE)}</span></div><div class="metric"><span class="label">Chính sách lệnh</span><span class="value">${escapeHtml(SHELL_MODE)}</span></div></div>
        <div class="endpoint"><code id="endpoint">${escapeHtml(endpoint)}</code><button class="copy" type="button" data-copy="endpoint">Sao chép</button></div>
        <div class="connection ${connectionClass}"><span>${setupReady ? '✓' : '!'}</span><div><b id="connection-label">${connectionLabel}</b><p id="connection-detail">Tunnel: ${status.tunnel.configured ? 'đã cấu hình' : 'chưa cấu hình'} · tunnel-client: ${status.tunnel.clientInstalled ? 'đã cài' : 'chưa cài'}</p></div></div>
        <div class="links"><a class="link" href="/healthz" target="_blank">Health check</a><a class="link" href="/readyz" target="_blank">Readiness check</a><a class="link" href="/api/status" target="_blank">Status JSON</a></div>
        <details class="details"><summary>Thông tin kỹ thuật</summary><ul><li>Alias Tunnel: <code>${escapeHtml(status.tunnel.alias)}</code></li><li>Tiến trình MCP quản lý: <span id="process-count">${status.processes.length}</span></li><li>Công cụ đã gọi: <span id="tool-count">${Object.values(status.toolsCalled).reduce((total, count) => total + count, 0)}</span></li></ul></details>
      </section>
      <aside class="panel"><h2>Kết nối Secure Tunnel</h2><p class="sub">Kết nối trực tiếp từ máy này, sau đó thêm Tunnel vào ChatGPT.</p>
        <form class="form" id="tunnel-form" autocomplete="off"><div class="field"><label for="tunnel-id">Tunnel ID</label><input id="tunnel-id" name="tunnelId" required placeholder="tunnel_..." value="${escapeHtml(status.tunnel.configured ? TUNNEL_ID : '')}"><small>Tạo Tunnel trong <a href="https://platform.openai.com/settings/organization/tunnels" target="_blank" rel="noreferrer">OpenAI Platform</a>.</small></div><div class="field"><label for="tunnel-alias">Tên kết nối (alias)</label><input id="tunnel-alias" name="alias" required value="${escapeHtml(status.tunnel.alias)}"></div><div class="field"><label for="runtime-key">Runtime API key</label><input id="runtime-key" name="runtimeApiKey" type="password" required placeholder="Nhập key có quyền Tunnels Read + Use"><small>Chỉ gửi qua loopback để chạy tunnel-client; không lưu file, không hiển thị lại.</small></div><div class="actions"><button class="primary" id="connect-button" type="submit">Kết nối Tunnel</button><button class="secondary" id="disconnect-button" type="button">Ngắt kết nối</button></div></form>
        <div class="result" id="tunnel-result" role="status"></div>
        <div class="hint"><b>Sau khi kết nối:</b> Vào <b>ChatGPT → Settings → Connectors → Add/configure MCP connector → Connection: Tunnel</b>, rồi chọn Tunnel ID này. Nếu chỉ xem giao diện, bạn không cần Tunnel.</div>
      </aside>
    </div>
  </main>
  <script>
    document.querySelector('[data-copy]').addEventListener('click', async (event) => { const button = event.currentTarget; try { await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent); button.textContent = 'Đã sao chép'; setTimeout(() => button.textContent = 'Sao chép', 1600); } catch { button.textContent = 'Hãy sao chép tay'; } });
    const tunnelForm = document.getElementById('tunnel-form'); const connectButton = document.getElementById('connect-button'); const disconnectButton = document.getElementById('disconnect-button'); const tunnelResult = document.getElementById('tunnel-result');
    function showTunnelResult(message, type = 'success') { tunnelResult.textContent = message; tunnelResult.className = 'result show ' + type; }
    function renderTunnel(tunnel) { const connected = tunnel.runtimeStatus === 'connected'; const connecting = tunnel.runtimeStatus === 'connecting' || tunnel.runtimeStatus === 'disconnecting'; document.getElementById('connection-label').textContent = connected ? 'Tunnel đã kết nối' : connecting ? 'Tunnel đang xử lý' : tunnel.runtimeStatus === 'failed' ? 'Tunnel gặp lỗi' : '${connectionLabel}'; document.getElementById('connection-detail').textContent = tunnel.lastMessage || ('Tunnel: ' + (tunnel.configured ? 'đã cấu hình' : 'chưa cấu hình') + ' · tunnel-client: ' + (tunnel.clientInstalled ? 'đã cài' : 'chưa cài')); disconnectButton.disabled = !(connecting || connected); }
    tunnelForm.addEventListener('submit', async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(tunnelForm)); connectButton.disabled = true; connectButton.textContent = 'Đang kết nối…'; try { const response = await fetch('/api/tunnel/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Không thể kết nối Tunnel.'); showTunnelResult('Đã gửi yêu cầu kết nối. Trạng thái sẽ tự cập nhật.', 'success'); renderTunnel(result.tunnel); } catch (error) { showTunnelResult(error.message, 'error'); } finally { document.getElementById('runtime-key').value = ''; connectButton.disabled = false; connectButton.textContent = 'Kết nối Tunnel'; } });
    disconnectButton.addEventListener('click', async () => { try { const response = await fetch('/api/tunnel/disconnect', { method: 'POST' }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Không thể ngắt Tunnel.'); renderTunnel(result.tunnel); showTunnelResult(result.tunnel.lastMessage, 'success'); } catch (error) { showTunnelResult(error.message, 'error'); } });
    async function refreshStatus() { try { const data = await fetch('/api/status', { cache: 'no-store' }).then(r => r.json()); document.getElementById('process-count').textContent = data.processes.length; document.getElementById('tool-count').textContent = Object.values(data.toolsCalled).reduce((total, count) => total + count, 0); renderTunnel(data.tunnel); } catch {} }
    refreshStatus();
    setInterval(refreshStatus, 10000);
  </script>
</body>
</html>`;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }

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
