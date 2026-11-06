// Smoke test: starts the server in mock mode on a random port and checks the things that must never
// silently break: the request guards, security headers, login, and a Wi-Fi config round trip.
// Zero dependencies. Run with `npm test`.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const assert = require('assert');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://localhost:${PORT}`;

function request(method, p, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(host ? { Host: host } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'X-N41-Unplug': '1' };

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL ${name}${detail ? ': ' + detail : ''}`);
  passed++; console.log(`ok  ${name}`);
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 50; i++) { try { if ((await request('GET', '/api/_meta')).status === 200) break; } catch {} await sleep(100); }

    let r = await request('GET', '/');
    check('UI page serves', r.status === 200 && r.text.includes('<title>n41 unplug</title>'));
    check('CSP header present', /default-src 'self'/.test(r.headers['content-security-policy'] || ''));
    check('nosniff + frame deny', r.headers['x-content-type-options'] === 'nosniff' && r.headers['x-frame-options'] === 'DENY');
    check('path traversal blocked', (await request('GET', '/../server.js')).status !== 200);

    r = await request('GET', '/api/_meta');
    check('_meta reports mock + autoExit field', r.json && r.json.mock === true && 'autoExit' in r.json);
    check('_ping works without custom header', (await request('GET', '/api/_ping')).status === 200);

    check('gateway call without header -> 403', (await request('GET', '/api/gateway?get=all')).status === 403);
    check('gateway call with header -> 200', (await request('GET', '/api/gateway?get=all', { headers: H })).status === 200);
    check('forged Host -> 403', (await request('GET', '/api/gateway?get=all', { headers: H, host: 'evil.example:' + PORT })).status === 403);
    check('foreign Origin -> 403', (await request('GET', '/api/gateway?get=all', { headers: { ...H, Origin: 'https://evil.example' } })).status === 403);
    check('same Origin -> 200', (await request('GET', '/api/gateway?get=all', { headers: { ...H, Origin: BASE } })).status === 200);
    check('unsupported method -> 405', (await request('PATCH', '/api/gateway?get=all', { headers: H })).status === 405);

    check('wrong password -> 401', (await request('POST', '/api/auth/login', { headers: H, body: { username: 'admin', password: 'nope' } })).status === 401);
    r = await request('POST', '/api/auth/login', { headers: H, body: { username: 'admin', password: 'mock' } });
    const token = r.json && r.json.auth && r.json.auth.token;
    check('login returns token', !!token);
    const A = { ...H, Authorization: 'Bearer ' + token };

    check('config without token -> 401', (await request('GET', '/api/network/configuration/v2?get=ap', { headers: H })).status === 401);
    r = await request('GET', '/api/network/configuration/v2?get=ap', { headers: A });
    check('config v2 get', r.status === 200 && Array.isArray(r.json.ssids) && r.json['2.4ghz'].isRadioEnabled === true);

    const cfg = r.json; cfg['6.0ghz'].isRadioEnabled = false;
    check('config v2 set', (await request('POST', '/api/network/configuration/v2?set=ap', { headers: A, body: cfg })).status === 200);
    r = await request('GET', '/api/network/configuration/v2?get=ap', { headers: A });
    check('config round trip persisted', r.json['6.0ghz'].isRadioEnabled === false && r.json['2.4ghz'].isRadioEnabled === true);

    check('telemetry clients', (await request('GET', '/api/network/telemetry?get=clients', { headers: A })).json.clients.ethernet.length === 1);
    check('unknown endpoint -> 404 passthrough', (await request('GET', '/api/nothing/here', { headers: A })).status === 404);
    check('server log has no secrets', !out.includes('mock-wifi-key') && !out.includes('"password"'));

    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error(e.message); console.error('--- server output ---\n' + out); process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
