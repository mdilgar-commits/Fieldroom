// Starts the server on a spare port and checks that the app and its APIs respond.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4300 + Math.floor(Math.random() * 500);
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLOUD_MODE: 'false', K_SERVICE: '' };
const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
const base = `http://127.0.0.1:${port}`;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/health`); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('Server did not start.');
}

const checks = [
  ['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css'],
  ['/vendor/pdfjs/pdf.min.mjs', 'text/javascript'], ['/api/health', 'application/json'],
  ['/api/config', 'application/json'], ['/api/account', 'application/json'], ['/api/state', 'application/json'],
];
let failed = 0;
try {
  await waitForServer();
  for (const [route, type] of checks) {
    const res = await fetch(base + route);
    const ok = res.status === 200 && (res.headers.get('content-type') || '').includes(type);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${route} -> ${res.status} ${res.headers.get('content-type')}`);
  }
  const state = await (await fetch(`${base}/api/state`)).json();
  if (!state?.project || !Array.isArray(state.project.rooms)) { failed++; console.log('FAIL /api/state shape'); }
} catch (error) { failed++; console.error(error.message); }
finally { child.kill(); }
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
