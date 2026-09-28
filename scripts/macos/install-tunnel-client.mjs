import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'bin');
const arch = os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'amd64' : null;
if (!arch) throw new Error(`Unsupported macOS architecture: ${os.arch()}`);

const headers = { 'User-Agent': 'vibecode-mcp-secure-setup', Accept: 'application/vnd.github+json' };
const release = await fetch('https://api.github.com/repos/openai/tunnel-client/releases/latest', { headers }).then(async r => {
  if (!r.ok) throw new Error(`Could not fetch tunnel-client release metadata (${r.status}).`);
  return r.json();
});
const assetPattern = new RegExp(`^tunnel-client-v.+-(?:darwin|macos)-${arch}\\.(?:tar\\.gz|zip)$`, 'i');
const asset = release.assets.find(item => assetPattern.test(item.name));
if (!asset) throw new Error(`No macOS ${arch} tunnel-client asset was found in ${release.tag_name}.`);

await fs.mkdir(bin, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vibecode-tunnel-'));
const archive = path.join(temp, asset.name);
try {
  const response = await fetch(asset.browser_download_url, { headers });
  if (!response.ok) throw new Error(`Could not download ${asset.name} (${response.status}).`);
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));

  const checksum = release.assets.find(item => item.name === 'SHA256SUMS.txt');
  if (checksum) {
    const sums = await fetch(checksum.browser_download_url, { headers }).then(r => r.ok ? r.text() : '');
    const expected = sums.split(/\r?\n/).find(line => line.includes(asset.name))?.trim().split(/\s+/)[0]?.toLowerCase();
    if (expected && createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== expected) throw new Error('SHA256 mismatch for tunnel-client archive.');
  }

  const extract = path.join(temp, 'extract');
  await fs.mkdir(extract);
  if (asset.name.endsWith('.zip')) execFileSync('unzip', ['-q', archive, '-d', extract]);
  else execFileSync('tar', ['-xzf', archive, '-C', extract]);
  const files = await fs.readdir(extract, { recursive: true });
  const relative = files.find(file => path.basename(file) === 'tunnel-client');
  if (!relative) throw new Error('tunnel-client was not found inside the downloaded archive.');
  const source = path.join(extract, relative);
  const destination = path.join(bin, 'tunnel-client');
  await fs.copyFile(source, destination);
  await fs.chmod(destination, 0o755);
  console.log(`Installed tunnel-client ${release.tag_name}: ${destination}`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
