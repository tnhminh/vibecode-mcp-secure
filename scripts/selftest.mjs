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
fs.writeFileSync(path.join(projectTemp, 'marker.txt'), 'project-router-ok', 'utf8');
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
  if (!controlCenter.ok || !controlCenterHtml.includes('Operations Console') || !controlCenterHtml.includes('Git & Verification') || !controlCenterHtml.includes('+ Add Project') || !controlCenterHtml.includes('Browse folders / drives') || !controlCenterHtml.includes('projectId</code>')) throw new Error('Control Center did not render explicit-project routing + folder picker UI.');
  if (controlCenterHtml.includes('preventFallback(')) throw new Error('Control Center regression: submit handlers must call event.preventDefault().');

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
  for (const required of ['health', 'project_list', 'repo_map', 'apply_patch', 'run_command', 'git_diff', 'verify_project', 'browser_open', 'audit_tail']) {
    if (!names.has(required)) throw new Error(`Required MCP tool missing: ${required}`);
  }
  const healthPayload = await fetch(`http://127.0.0.1:${selftestPort}/healthz`).then(r => r.json());
  if (healthPayload.serverRoot !== root) throw new Error(`Server identity mismatch: expected ${root}, got ${healthPayload.serverRoot || 'missing'}.`);
  const health = await client.callTool({ name: 'health', arguments: {} });
  if (health.isError) throw new Error(`health tool returned error: ${JSON.stringify(health.content)}`);
  const projectsBefore = await fetch(`http://127.0.0.1:${selftestPort}/api/projects`).then(r => r.json());
  const rootProject = projectsBefore.projects[0];
  if (!rootProject) throw new Error('Multi-Project Router regression: no initial approved project.');

  const directDenied = await client.callTool({ name: 'run_command', arguments: { projectId: rootProject.id, command: 'whoami' } });
  if (!directDenied.isError) throw new Error('Shell allowlist regression: direct blocked executable was allowed.');
  const chainedDenied = await client.callTool({ name: 'run_command', arguments: { projectId: rootProject.id, command: 'node --version & whoami' } });
  if (!chainedDenied.isError) throw new Error('Shell allowlist regression: single-& command chaining bypass was allowed.');

  const junctionDenied = await client.callTool({ name: 'read_file', arguments: { projectId: rootProject.id, path: '.vibecode-artifacts/selftest-outside-junction/outside.txt' } });
  if (!junctionDenied.isError) throw new Error('Workspace regression: junction escape was allowed.');

  const auditProbe = 'selftest-sensitive-content-' + Date.now();
  const writeProbe = await client.callTool({ name: 'write_file', arguments: { projectId: rootProject.id, path: '.vibecode-artifacts/selftest-audit.txt', content: auditProbe } });
  if (writeProbe.isError) throw new Error('Audit redaction probe write failed.');
  const auditTail = await client.callTool({ name: 'audit_tail', arguments: { limit: 20 } });
  if (JSON.stringify(auditTail).includes(auditProbe)) throw new Error('Audit regression: file content leaked into audit output.');
  await client.callTool({ name: 'delete_path', arguments: { projectId: rootProject.id, path: '.vibecode-artifacts/selftest-audit.txt', confirm: true } });


  const foldersBefore = await fetch(`http://127.0.0.1:${selftestPort}/api/folders?path=${encodeURIComponent(projectTemp)}`).then(r => r.json());
  if (!foldersBefore.ok || foldersBefore.currentPath !== projectTemp || !Array.isArray(foldersBefore.roots)) throw new Error('Folder picker regression: selected folder could not be listed.');
  const createdFolder = await fetch(`http://127.0.0.1:${selftestPort}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentPath: projectTemp, name: 'created-from-picker' })
  });
  const createdFolderJson = await createdFolder.json();
  if (!createdFolder.ok || !fs.existsSync(createdFolderJson.createdPath)) throw new Error(`Folder picker regression: create failed: ${JSON.stringify(createdFolderJson)}`);
  const invalidFolder = await fetch(`http://127.0.0.1:${selftestPort}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentPath: projectTemp, name: '../escape' })
  });
  if (invalidFolder.status !== 400) throw new Error('Folder picker regression: path traversal folder name was accepted.');

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
  if (!addProjectResponse.ok || !addProjectJson.project?.id) throw new Error(`Multi-Project Router regression: add failed: ${JSON.stringify(addProjectJson)}`);
  if (!addProjectJson.project?.ports?.frontend || !addProjectJson.project?.ports?.backend || !addProjectJson.project?.ports?.worker) throw new Error('Deployment port allocation regression: project ports missing.');
  const testProjectId = addProjectJson.project.id;

  const listAfterAdd = await client.callTool({ name: 'project_list', arguments: {} });
  if (listAfterAdd.isError || !JSON.stringify(listAfterAdd).includes(testProjectId)) throw new Error('Multi-Project Router regression: approved project missing from project_list.');

  const markerRead = await client.callTool({ name: 'read_file', arguments: { projectId: testProjectId, path: 'marker.txt' } });
  if (markerRead.isError || !JSON.stringify(markerRead).includes('project-router-ok')) throw new Error('Multi-Project Router regression: explicit projectId did not route to secondary project.');

  const missingProject = await client.callTool({ name: 'project_info', arguments: {} });
  if (!missingProject.isError || !JSON.stringify(missingProject).includes('projectId')) throw new Error('Project routing regression: missing projectId must be rejected.');

  const writeDenied = await client.callTool({ name: 'write_file', arguments: { projectId: testProjectId, path: 'blocked.txt', content: 'must-not-write' } });
  if (!writeDenied.isError) throw new Error('Project permission regression: write=false was not enforced on targeted project.');

  const permissionResponse = await fetch(`http://127.0.0.1:${selftestPort}/api/projects/${encodeURIComponent(testProjectId)}/permissions`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: { write: true, delete: true } })
  });
  if (!permissionResponse.ok) throw new Error('Project permission regression: permission update failed.');
  const writeAllowed = await client.callTool({ name: 'write_file', arguments: { projectId: testProjectId, path: 'allowed.txt', content: 'permission-ok' } });
  if (writeAllowed.isError) throw new Error('Project permission regression: write=true was not applied to targeted project.');

  if (tools.some(tool => ['project_set_default', 'project_switch'].includes(tool.name))) {
    throw new Error('Multi-Project Router regression: MCP must not expose global routing mutation tools.');
  }

  const explicitRoot = await client.callTool({ name: 'project_info', arguments: { projectId: rootProject.id } });
  if (explicitRoot.isError || !JSON.stringify(explicitRoot).includes(path.basename(root))) throw new Error('Multi-Project Router regression: explicit root routing failed.');
  const removeResponse = await fetch(`http://127.0.0.1:${selftestPort}/api/projects/${encodeURIComponent(testProjectId)}`, { method: 'DELETE' });
  if (!removeResponse.ok) throw new Error('Multi-Project Router regression: remove failed.');

  const status = await fetch(`http://127.0.0.1:${selftestPort}/api/status`);
  const statusJson = await status.json();
  if (!status.ok || !statusJson.security || !statusJson.processes || !statusJson.activity) throw new Error('Operations status API is incomplete.');

  console.log(`SELFTEST PASS: HTTP health + Operations Console + Multi-Project Router + MCP ${client.getProtocolEra() || 'negotiated'} + ${tools.length} tools + concurrent project routing/permissions/shell/junction/audit regressions`);
} finally {
  try { await client?.close(); } catch {}
  child.kill('SIGTERM');
  fs.rmSync(junction, { recursive: true, force: true });
  fs.rmSync(outsideTemp, { recursive: true, force: true });
  fs.rmSync(runtimeTemp, { recursive: true, force: true });
  fs.rmSync(projectTemp, { recursive: true, force: true });
  if (backup === null) fs.rmSync(envFile, { force: true }); else fs.writeFileSync(envFile, backup);
}
