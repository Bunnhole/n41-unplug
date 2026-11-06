#!/usr/bin/env node
// Gateway Console: unofficial local console for Arcadyan/Sercomm T-Mobile Home Internet gateways.
// Serves the UI from ./public and proxies /api/* to http://<gateway>/TMI/v1/*. Binds to 127.0.0.1 only.
// Zero dependencies. Node 18+ (uses global fetch).
//
//   node server.js                      -> proxy to 192.168.12.1 on http://localhost:8787
//   node server.js --gateway 192.168.12.1 --port 8787
//   node server.js --mock               -> fake gateway for UI testing (password: mock)

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}
const MOCK = args.includes('--mock');
const AUTO_EXIT = args.includes('--auto-exit'); // quit when no console page has pinged for a few seconds
const GATEWAY = arg('gateway', process.env.GATEWAY_HOST || '192.168.12.1');
const PORT = parseInt(arg('port', process.env.PORT || '8787'), 10);

// The gateway address must be a plain hostname or IP: this is the only place the proxy will ever send a request.
if (!/^[A-Za-z0-9.\-]+$/.test(GATEWAY)) { console.error(`Invalid --gateway "${GATEWAY}"`); process.exit(1); }
if (!(PORT > 0 && PORT < 65536)) { console.error(`Invalid --port "${PORT}"`); process.exit(1); }

// Only ever answer requests that were addressed to this machine by name. A web page on another site can
// make the browser send requests to localhost, but it cannot forge the Host header or the custom header below.
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
function isLocalRequest(req) {
  if (!LOCAL_HOSTS.has(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (origin && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  return true;
}
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const PUBLIC = path.join(__dirname, 'public');
const mock = MOCK ? require('./mock') : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function proxy(req, res, url) {
  const apiPath = url.pathname.slice('/api'.length) || '/';
  const body = await readBody(req);

  if (mock) {
    const r = await mock.handle(req.method, apiPath, url.searchParams, body.toString(), req.headers.authorization);
    return send(res, r.status, JSON.stringify(r.body));
  }

  const target = `http://${GATEWAY}/TMI/v1${apiPath}${url.search}`;
  const headers = { Accept: 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (body.length) headers['Content-Type'] = req.headers['content-type'] || 'application/json';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(target, { method: req.method, headers, body: body.length ? body : undefined, signal: ctrl.signal });
    const text = await r.text();
    console.log(`${req.method} ${apiPath}${url.search} -> ${r.status}`);
    send(res, r.status, text, r.headers.get('content-type') || 'application/json');
  } catch (e) {
    console.log(`${req.method} ${apiPath}${url.search} -> unreachable (${e.message})`);
    send(res, 502, JSON.stringify({ error: 'gateway unreachable', detail: String(e.message || e), target }));
  } finally {
    clearTimeout(timer);
  }
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

// Liveness: the page pings every 2s and sends _bye on pagehide. With --auto-exit the server quits
// ~8s after the last ping (60s grace at startup so the browser has time to open).
let lastSeen = Date.now();
let everSeen = false;
if (AUTO_EXIT) {
  setInterval(() => {
    const idle = Date.now() - lastSeen;
    if ((everSeen && idle > 8000) || (!everSeen && idle > 60000)) {
      console.log('No console window open, exiting.');
      process.exit(0);
    }
  }, 1000).unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!isLocalRequest(req)) return send(res, 403, JSON.stringify({ error: 'forbidden: request not addressed to localhost' }));
  if (url.pathname === '/api/_meta') {
    return send(res, 200, JSON.stringify({ gateway: GATEWAY, mock: MOCK, port: PORT, autoExit: AUTO_EXIT }));
  }
  if (url.pathname === '/api/_ping') { lastSeen = Date.now(); everSeen = true; return send(res, 200, '{"ok":true}'); }
  if (url.pathname === '/api/_bye') { lastSeen = Date.now() - 5000; everSeen = true; return send(res, 200, '{"ok":true}'); }
  if (url.pathname.startsWith('/api/')) {
    // Gateway calls need a custom header. Cross-site pages cannot add one without a CORS preflight, which we never grant.
    if (req.headers['x-gateway-console'] !== '1') return send(res, 403, JSON.stringify({ error: 'forbidden: missing X-Gateway-Console header' }));
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    return proxy(req, res, url);
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Gateway Console  http://localhost:${PORT}`);
  console.log(MOCK ? 'Mode: MOCK gateway (password: mock)' : `Gateway: http://${GATEWAY}/TMI/v1`);
  if (AUTO_EXIT) console.log('Auto-exit: on (quits when the console window closes)');
});
