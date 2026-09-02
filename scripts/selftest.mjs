import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
const backup = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
const selftestPort = 17417;
const outsideTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-selftest-'));
const runtimeTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-runtime-'));
const projectTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-project-'));
fs.writeFileSync(path.join(projectTemp, 'marker.txt'), 'project-switch-ok', 'utf8');
const junction = path.join(root, '.vibecode-artifacts', 'selftest-outside-junction');
fs.mkdirSync(path.dirname(junction), { recursive: true });
fs.rmSync(junction, { recursive: true, force: true });
fs.writeFileSync(path.join(outsideTemp, 'outside.txt'), 'outside-workspace', 'utf8');
fs.symlinkSync(outsideTemp, junction, process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(envFile, `VIBECODE_WORKSPACE=${root}\nVIBECODE_HOST=127.0.0.1\nVIBECODE_PORT=${selftestPort}\nVIBECODE_SHELL_MODE=allowlist\n`);

const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    VIBECODE_WORKSPACE: root,
    VIBECODE_RUNTIME_DIR: runtimeTemp,
    VIBECODE_HOST: '127.0.0.1',
    VIBECODE_PORT: String(selftestPort),
    VIBECODE_SHELL_MODE: 'allowlist',
    VIBECODE_ALLOW_DANGEROUS: '0',
    VIBECODE_BROWSER_ALLOW_EXTERNAL: '0'
  }
});
let stderr = '';
child.stderr.on('data', d => stderr += d.toString());
let client;
try {
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${selftestPort}/healthz`);
      if (res.ok) { ok = true; break; }
    } catch {}
  }
  if (!ok) throw new Error(`Server did not become healthy. ${stderr}`);

  const ready = await fetch(`http://127.0.0.1:${selftestPort}/readyz`);
  if (!ready.ok) throw new Error(`readyz failed: ${await ready.text()}`);

  const controlCenter = await fetch(`http://127.0.0.1:${selftestPort}/`);
  const controlCenterHtml = await controlCenter.text();
  if (!controlCenter.ok || !controlCenterHtml.includes('Operations Console') || !controlCenterHtml.includes('Git & Verification') || !controlCenterHtml.includes('+ Add Project')) throw new Error('Control Center did not render Operations Console + Project Manager UI.');

  const invalidTunnel = await fetch(`http://127.0.0.1:${selftestPort}/api/tunnel/connect`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tunnelId: 'not-a-tunnel', alias: 'selftest', runtimeApiKey: '' })
  });
  if (invalidTunnel.status !== 400) throw new Error(`Tunnel connection validation returned ${invalidTunnel.status}, expected 400.`);

  client = new Client({ name: 'vibecode-selftest', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${selftestPort}/mcp`));
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map(t => t.name));
  for (const required of ['health', 'project_list', 'project_switch', 'repo_map', 'apply_patch', 'run_command', 'git_diff', 'verify_project', 'browser_open', 'audit_tail']) {
    if (!names.has(required)) throw new Error(`Required MCP tool missing: ${required}`);
  }
  const health = await client.callTool({ name: 'health', arguments: {} });
  if (health.isError) throw new Error(`health tool returned error: ${JSON.stringify(health.content)}`);

  const directDenied = await client.callTool({ name: 'run_command', arguments: { command: 'whoami' } });
  if (!directDenied.isError) throw new Error('Shell allowlist regression: direct blocked executable was allowed.');
  const chainedDenied = await client.callTool({ name: 'run_command', arguments: { command: 'node --version & whoami' } });
  if (!chainedDenied.isError) throw new Error('Shell allowlist regression: single-& command chaining bypass was allowed.');

  const junctionDenied = await client.callTool({ name: 'read_file', arguments: { path: '.vibecode-artifacts/selftest-outside-junction/outside.txt' } });
  if (!junctionDenied.isError) throw new Error('Workspace regression: junction escape was allowed.');

  const auditProbe = 'selftest-sensitive-content-' + Date.now();
  const writeProbe = await client.callTool({ name: 'write_file', arguments: { path: '.vibecode-artifacts/selftest-audit.txt', content: auditProbe } });
  if (writeProbe.isError) throw new Error('Audit redaction probe write failed.');
  const auditTail = await client.callTool({ name: 'audit_tail', arguments: { limit: 20 } });
  if (JSON.stringify(auditTail).includes(auditProbe)) throw new Error('Audit regression: file content leaked into audit output.');
  await client.callTool({ name: 'delete_path', arguments: { path: '.vibecode-artifacts/selftest-audit.txt', confirm: true } });

  const projectsBefore = await fetch(`http://127.0.0.1:${selftestPort}/api/projects`).then(r => r.json());
  const rootProject = projectsBefore.projects.find(p => p.active);
  if (!rootProject) throw new Error('Project Manager regression: no active initial project.');

  const addProjectResponse = await fetch(`http://127.0.0.1:${selftestPort}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'selftest-project',
      workspace: projectTemp,
      permissions: { read: true, write: false, execute: false, process: false, gitWrite: false, browser: false, delete: false }
    })
  });
  const addProjectJson = await addProjectResponse.json();
  if (!addProjectResponse.ok || !addProjectJson.project?.id) throw new Error(`Project Manager regression: add failed: ${JSON.stringify(addProjectJson)}`);
  const testProjectId = addProjectJson.project.id;

  const switchProject = await client.callTool({ name: 'project_switch', arguments: { projectId: testProjectId } });
  if (switchProject.isError) throw new Error('Project Manager regression: MCP project_switch failed.');
  const markerRead = await client.callTool({ name: 'read_file', arguments: { path: 'marker.txt' } });
  if (markerRead.isError || !JSON.stringify(markerRead).includes('project-switch-ok')) throw new Error('Project Manager regression: active workspace did not switch.');

  const writeDenied = await client.callTool({ name: 'write_file', arguments: { path: 'blocked.txt', content: 'must-not-write' } });
  if (!writeDenied.isError) throw new Error('Project permission regression: write=false was not enforced.');

  const permissionResponse = await fetch(`http://127.0.0.1:${selftestPort}/api/projects/${encodeURIComponent(testProjectId)}/permissions`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: { write: true, delete: true } })
  });
  if (!permissionResponse.ok) throw new Error('Project permission regression: permission update failed.');
  const writeAllowed = await client.callTool({ name: 'write_file', arguments: { path: 'allowed.txt', content: 'permission-ok' } });
  if (writeAllowed.isError) throw new Error('Project permission regression: write=true was not applied.');

  const switchBack = await client.callTool({ name: 'project_switch', arguments: { projectId: rootProject.id } });
  if (switchBack.isError) throw new Error('Project Manager regression: switch back failed.');
  const removeResponse = await fetch(`http://127.0.0.1:${selftestPort}/api/projects/${encodeURIComponent(testProjectId)}`, { method: 'DELETE' });
  if (!removeResponse.ok) throw new Error('Project Manager regression: remove failed.');

  const status = await fetch(`http://127.0.0.1:${selftestPort}/api/status`);
  const statusJson = await status.json();
  if (!status.ok || !statusJson.security || !statusJson.processes || !statusJson.activity) throw new Error('Operations status API is incomplete.');

  console.log(`SELFTEST PASS: HTTP health + Operations Console + Project Manager + MCP ${client.getProtocolEra() || 'negotiated'} + ${tools.length} tools + permissions/shell/junction/audit regressions`);
} finally {
  try { await client?.close(); } catch {}
  child.kill('SIGTERM');
  fs.rmSync(junction, { recursive: true, force: true });
  fs.rmSync(outsideTemp, { recursive: true, force: true });
  fs.rmSync(runtimeTemp, { recursive: true, force: true });
  fs.rmSync(projectTemp, { recursive: true, force: true });
  if (backup === null) fs.rmSync(envFile, { force: true }); else fs.writeFileSync(envFile, backup);
}
