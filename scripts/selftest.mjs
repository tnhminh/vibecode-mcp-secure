import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
const backup = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
fs.writeFileSync(envFile, `VIBECODE_WORKSPACE=${root}\nVIBECODE_HOST=127.0.0.1\nVIBECODE_PORT=17317\nVIBECODE_SHELL_MODE=allowlist\n`);

const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', d => stderr += d.toString());
let client;
try {
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch('http://127.0.0.1:17317/healthz');
      if (res.ok) { ok = true; break; }
    } catch {}
  }
  if (!ok) throw new Error(`Server did not become healthy. ${stderr}`);

  const ready = await fetch('http://127.0.0.1:17317/readyz');
  if (!ready.ok) throw new Error(`readyz failed: ${await ready.text()}`);

  const controlCenter = await fetch('http://127.0.0.1:17317/');
  const controlCenterHtml = await controlCenter.text();
  if (!controlCenter.ok || !controlCenterHtml.includes('Kết nối Secure Tunnel')) throw new Error('Control Center did not render Tunnel connection UI.');

  const invalidTunnel = await fetch('http://127.0.0.1:17317/api/tunnel/connect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tunnelId: 'not-a-tunnel', alias: 'selftest', runtimeApiKey: '' })
  });
  if (invalidTunnel.status !== 400) throw new Error(`Tunnel connection validation returned ${invalidTunnel.status}, expected 400.`);

  client = new Client({ name: 'vibecode-selftest', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:17317/mcp'));
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map(t => t.name));
  for (const required of ['health', 'repo_map', 'apply_patch', 'run_command', 'git_diff', 'verify_project', 'browser_open', 'audit_tail']) {
    if (!names.has(required)) throw new Error(`Required MCP tool missing: ${required}`);
  }
  const health = await client.callTool({ name: 'health', arguments: {} });
  if (health.isError) throw new Error(`health tool returned error: ${JSON.stringify(health.content)}`);

  console.log(`SELFTEST PASS: HTTP health + MCP ${client.getProtocolEra() || 'negotiated'} + ${tools.length} tools`);
} finally {
  try { await client?.close(); } catch {}
  child.kill('SIGTERM');
  if (backup === null) fs.rmSync(envFile, { force: true }); else fs.writeFileSync(envFile, backup);
}
