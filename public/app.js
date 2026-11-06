/* n41 unplug front end. Vanilla JS, talks to /api/* which the local server proxies to the gateway. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const main = $('#main');

const state = {
  token: sessionStorage.getItem('gw_token') || null,
  meta: { gateway: '?', mock: false },
  view: 'overview',
  ap: null,          // working copy of the Wi-Fi (access point) config
  apOriginal: null,  // last loaded copy, for dirty checks
  apPath: null,      // '/network/configuration/v2' on API 1.6+ firmware (G5AR), '/network/configuration' on older
  timer: null,
  auto: { overview: true, cellular: true, clients: false },
};

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
function toast(msg, kind = '') {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toast').append(t);
  setTimeout(() => t.remove(), 4500);
}
function fmtUptime(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m`;
}
function fmtTime(epoch) { return epoch ? new Date(epoch * 1000).toLocaleString() : '—'; }
function bars(n, max = 5) {
  return el('span', { class: 'bars' }, ...Array.from({ length: max }, (_, i) => el('i', { class: i < n ? 'on' : '' })));
}
function kv(obj, keys) {
  const rows = [];
  for (const [k, label] of keys) {
    if (obj == null) continue;
    let v = obj[k] !== undefined ? obj[k] : k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
    if (v === undefined) continue;
    if (Array.isArray(v)) v = v.join(', ');
    if (typeof v === 'boolean') v = v ? 'yes' : 'no';
    rows.push(el('div', { class: 'k' }, label), el('div', { class: 'v' }, String(v)));
  }
  return el('div', { class: 'kv' }, ...rows);
}
function deep(o) { return JSON.parse(JSON.stringify(o)); }
function getPath(o, path) { return path.reduce((a, k) => (a == null ? undefined : a[k]), o); }
function setPath(o, path, v) { const last = path[path.length - 1]; getPath(o, path.slice(0, -1))[last] = v; }

// ---------- API ----------
async function api(method, path, body) {
  const headers = { 'X-N41-Unplug': '1' }; // the server refuses gateway calls without this (cross-site request guard)
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (r.status === 401 && state.token) { setToken(null); showLogin('Session expired or rejected. Log in again.'); }
  if (!r.ok) {
    const e = new Error(`${r.status} on ${method} ${path}`);
    e.status = r.status; e.data = data; throw e;
  }
  return data;
}
function setToken(t, expiration) {
  state.token = t;
  if (t) sessionStorage.setItem('gw_token', t); else sessionStorage.removeItem('gw_token');
  if (expiration) sessionStorage.setItem('gw_token_exp', String(expiration)); else if (!t) sessionStorage.removeItem('gw_token_exp');
  $('#auth-state').textContent = t ? 'Logged in as admin' : 'Not logged in';
  $('#auth-btn').textContent = t ? 'Log out' : 'Log in';
  scheduleRefresh();
}
// Gateway tokens expire (the login reply says when). Refresh a minute early so long sessions never bounce to the login box.
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer); refreshTimer = null;
  const exp = Number(sessionStorage.getItem('gw_token_exp') || 0);
  if (!state.token || !exp) return;
  const delay = Math.max(10000, exp * 1000 - Date.now() - 60000);
  refreshTimer = setTimeout(async () => {
    try {
      const r = await api('POST', '/auth/refresh', {});
      const tok = r?.auth?.token || r?.token;
      if (tok) setToken(tok, r?.auth?.expiration); else throw new Error('no token in refresh reply');
    } catch (e) {
      // Refresh is best-effort; the next 401 will prompt for login.
      sessionStorage.removeItem('gw_token_exp');
    }
  }, delay);
}
function requireAuth() { if (!state.token) { showLogin(); return false; } return true; }

// ---------- login ----------
function showLogin(msg) {
  if (msg) $('#login-msg').textContent = msg;
  $('#login').classList.remove('hidden');
  setTimeout(() => $('#login-form input[name=password]').focus(), 50);
}
$('#login-cancel').onclick = () => $('#login').classList.add('hidden');
$('#login-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api('POST', '/auth/login', { username: f.username.value, password: f.password.value });
    const tok = r?.auth?.token || r?.token;
    if (!tok) throw new Error('No token in response: ' + JSON.stringify(r).slice(0, 200));
    setToken(tok, r?.auth?.expiration);
    f.password.value = '';
    $('#login').classList.add('hidden');
    toast('Logged in', 'ok');
    render();
  } catch (e) {
    $('#login-msg').textContent = 'Login failed: ' + (e.data?.message || e.message);
  }
};
$('#auth-btn').onclick = () => {
  if (state.token) { setToken(null); state.ap = null; toast('Logged out'); render(); } else showLogin();
};

// ---------- nav ----------
$('#nav').onclick = (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  state.view = b.dataset.view;
  $$('#nav button').forEach((x) => x.classList.toggle('active', x === b));
  render();
};

function render() {
  clearInterval(state.timer); state.timer = null;
  main.innerHTML = '';
  ({ overview: viewOverview, wifi: viewWifi, clients: viewClients, cellular: viewCellular, advanced: viewAdvanced, tools: viewTools })[state.view]();
}
function head(title, ...tools) {
  return el('div', { class: 'view-head' }, el('h1', {}, title), el('div', { class: 'toolbar' }, ...tools));
}
function autoToggle(key, fn, ms) {
  const cb = el('input', { type: 'checkbox' });
  cb.checked = !!state.auto[key];
  cb.onchange = () => { state.auto[key] = cb.checked; clearInterval(state.timer); if (cb.checked) state.timer = setInterval(fn, ms); };
  if (cb.checked) state.timer = setInterval(fn, ms);
  return el('label', { class: 'row muted', style: 'font-size:13px' }, cb, ` auto-refresh ${ms / 1000}s`);
}
function errorBox(e) {
  const msg = e.status === 502 ? `Gateway unreachable at ${state.meta.gateway}. Plug into one of its Ethernet ports or join its Wi-Fi, then reload.` : (e.data?.message || e.message);
  return el('div', { class: 'banner bad' }, msg);
}

// ---------- Overview ----------
async function viewOverview() {
  const body = el('div');
  main.append(head('Overview', autoToggle('overview', load, 10000), el('button', { class: 'btn small', onclick: load }, 'Refresh')), body);
  async function load() {
    try {
      const g = await api('GET', '/gateway?get=all');
      const d = g.device || {}, s = g.signal || {}, t = g.time || {};
      body.innerHTML = '';
      body.append(el('div', { class: 'grid' },
        el('div', { class: 'card' }, el('h3', {}, 'Device', d.updateState ? el('span', { class: 'pill ' + (d.updateState === 'latest' ? 'ok' : 'warn') }, d.updateState) : null),
          kv(d, [['model', 'Model'], ['manufacturer', 'Manufacturer'], ['softwareVersion', 'Firmware'], ['hardwareVersion', 'Hardware'], ['serial', 'Serial'], ['macId', 'MAC'], ['friendlyName', 'Name']])),
        el('div', { class: 'card' }, el('h3', {}, 'Connection', el('span', { class: 'pill ' + (s.generic?.registration === 'registered' ? 'ok' : 'bad') }, s.generic?.registration || '?')),
          kv({ ...s.generic, upTime: fmtUptime(t.upTime), localTime: fmtTime(t.localTime) }, [['apn', 'APN'], ['roaming', 'Roaming'], ['hasIPv6', 'IPv6'], ['upTime', 'Uptime'], ['localTime', 'Gateway time']])),
        signalCard('5G NR', s['5g']), signalCard('4G LTE', s['4g']),
      ));
    } catch (e) { body.innerHTML = ''; body.append(errorBox(e)); }
  }
  load();
}
function signalCard(title, sig) {
  if (!sig) return el('div', { class: 'card' }, el('h3', {}, title), el('div', { class: 'muted' }, 'not connected'));
  return el('div', { class: 'card' },
    el('h3', {}, title, el('span', {}, el('span', { class: 'big' }, sig.bars ?? '–'), bars(sig.bars || 0))),
    kv(sig, [['bands', 'Bands'], ['rsrp', 'RSRP (dBm)'], ['rsrq', 'RSRQ (dB)'], ['sinr', 'SINR (dB)'], ['rssi', 'RSSI (dBm)'], ['pci', 'PCI'], ['cid', 'Cell ID'], ['eNBID', 'eNB ID'], ['gNBID', 'gNB ID'], ['nci', 'NCI'], ['antennaUsed', 'Antenna']]));
}

// ---------- Wi-Fi ----------
const LABELS = {
  isRadioEnabled: 'Radio on', channel: 'Channel', channelBandwidth: 'Channel width', transmissionPower: 'Transmit power', mode: 'Mode',
  maxClients: 'Max clients', isMUMIMOEnabled: 'MU-MIMO', isWMMEnabled: 'WMM', airtimeFairness: 'Airtime fairness', isEnabled: 'Enabled',
  ssidName: 'Network name (SSID)', wpaKey: 'Password', encryptionVersion: 'WPA version', encryptionMode: 'Encryption', isBroadcastEnabled: 'Visible (broadcast SSID)',
  guest: 'Guest network', '2.4ghzSsid': 'On 2.4 GHz', '5.0ghzSsid': 'On 5 GHz', '6.0ghzSsid': 'On 6 GHz',
};
const SUGGEST = {
  channelBandwidth: ['Auto', '20MHz', '40MHz', '80MHz', '160MHz'],
  transmissionPower: ['100%', '75%', '50%', '25%'],
  encryptionVersion: ['WPA2', 'WPA2/WPA3', 'WPA3'],
  encryptionMode: ['AES', 'TKIP/AES'],
  mode: ['auto'],
};
const CHANNELS = { '2.4ghz': ['Auto', ...Array.from({ length: 11 }, (_, i) => String(i + 1))], '5.0ghz': ['Auto', '36', '40', '44', '48', '149', '153', '157', '161', '165'], '6.0ghz': ['Auto'] };
const BAND_NAMES = { '2.4ghz': '2.4 GHz', '5.0ghz': '5 GHz', '6.0ghz': '6 GHz' };
const SECRET_KEYS = /key|password|passphrase/i;

function fieldFor(path, value, onChange, opts = {}) {
  const key = path[path.length - 1];
  const label = LABELS[key] || key;
  if (typeof value === 'boolean') {
    const cb = el('input', { type: 'checkbox' }); cb.checked = value;
    cb.onchange = () => onChange(cb.checked);
    return el('label', { class: 'field toggle' }, el('span', {}, label), el('span', { class: 'switch' }, cb, el('span', { class: 'track' })));
  }
  if (typeof value === 'number') {
    const inp = el('input', { type: 'number', value });
    inp.onchange = () => onChange(Number(inp.value));
    return el('label', { class: 'field' }, el('span', {}, label), inp);
  }
  if (typeof value === 'string') {
    const secret = SECRET_KEYS.test(key);
    const inp = el('input', { type: secret ? 'password' : 'text', value });
    inp.onchange = () => onChange(inp.value);
    const suggestions = opts.suggest || SUGGEST[key];
    let wrap = inp;
    if (suggestions) {
      const id = 'dl_' + path.join('_').replace(/\W/g, '_');
      inp.setAttribute('list', id);
      wrap = el('span', {}, inp, el('datalist', { id }, ...suggestions.map((s) => el('option', { value: s }))));
    }
    if (secret) {
      const eye = el('button', { type: 'button', class: 'btn small', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; } }, 'show');
      wrap = el('span', { class: 'pw-wrap' }, inp, eye);
    }
    return el('label', { class: 'field' }, el('span', {}, label), wrap);
  }
  // objects/arrays nested deeper than we render: show as JSON text
  const ta = el('textarea', { class: 'json', style: 'min-height:80px' }, JSON.stringify(value, null, 1));
  ta.onchange = () => { try { onChange(JSON.parse(ta.value)); } catch { toast('Invalid JSON in ' + key, 'bad'); } };
  return el('label', { class: 'field', style: 'grid-column:1/-1' }, el('span', {}, label + ' (JSON)'), ta);
}
const KEY_ORDER = ['isRadioEnabled', 'isEnabled', 'ssidName', 'wpaKey', 'isBroadcastEnabled', 'guest', '2.4ghzSsid', '5.0ghzSsid', '6.0ghzSsid', 'encryptionVersion', 'encryptionMode', 'channel', 'channelBandwidth', 'transmissionPower', 'mode', 'maxClients'];
function objectForm(obj, basePath, onChange, opts = {}) {
  const f = el('div', { class: 'form' });
  const rank = (k) => { const i = KEY_ORDER.indexOf(k); return i < 0 ? 999 : i; };
  const entries = Object.entries(obj).sort((a, b) => rank(a[0]) - rank(b[0]));
  for (const [k, v] of entries) {
    const path = [...basePath, k];
    f.append(fieldFor(path, v, (nv) => onChange(path, nv), { suggest: opts.suggest?.[k] }));
  }
  return f;
}

async function viewWifi() {
  if (!requireAuth()) { main.append(head('Wi-Fi'), el('div', { class: 'empty' }, 'Log in to view Wi-Fi settings.')); return; }
  const body = el('div');
  let jsonMode = false;
  const saveBtn = el('button', { class: 'btn primary', onclick: save }, 'Save changes');
  const reloadBtn = el('button', { class: 'btn', onclick: () => load(true) }, 'Reload');
  const jsonBtn = el('button', { class: 'btn', onclick: () => { jsonMode = !jsonMode; jsonBtn.textContent = jsonMode ? 'Form view' : 'Edit as JSON'; draw(); } }, 'Edit as JSON');
  const offBtn = el('button', { class: 'btn danger', onclick: () => setAllRadios(false) }, 'All Wi-Fi OFF');
  const onBtn = el('button', { class: 'btn', onclick: () => setAllRadios(true) }, 'All Wi-Fi ON');
  main.append(head('Wi-Fi', offBtn, onBtn, jsonBtn, reloadBtn, saveBtn), el('div', { class: 'note' }, 'Changes are applied together when you press Save. If you are connected over the gateway\'s Wi-Fi, turning a radio off will drop you.'), body);

  function dirty() { return JSON.stringify(state.ap) !== JSON.stringify(state.apOriginal); }
  function markDirty() { saveBtn.disabled = !dirty(); saveBtn.textContent = dirty() ? 'Save changes *' : 'Save changes'; }
  const isBand = (k, v) => v && typeof v === 'object' && !Array.isArray(v) && 'isRadioEnabled' in v;

  async function load(force) {
    if (state.ap && !force) { draw(); return; }
    body.innerHTML = ''; body.append(el('div', { class: 'muted' }, 'Loading…'));
    try {
      const cfg = await loadApConfig();
      state.apOriginal = deep(cfg); state.ap = deep(cfg);
      draw();
    } catch (e) { body.innerHTML = ''; body.append(errorBox(e)); }
  }
  async function loadApConfig() {
    // Newer firmware (API 1.6+, e.g. G5AR) serves Wi-Fi config at /v2 and 404s the old path. Try v2 first.
    const candidates = state.apPath ? [state.apPath] : ['/network/configuration/v2', '/network/configuration'];
    let lastErr;
    for (const p of candidates) {
      try { const cfg = await api('GET', p + '?get=ap'); state.apPath = p; return cfg; }
      catch (e) { lastErr = e; if (e.status !== 404) throw e; }
    }
    throw lastErr;
  }
  function draw() {
    body.innerHTML = ''; markDirty();
    const ap = state.ap; if (!ap) return;
    if (jsonMode) {
      const ta = el('textarea', { class: 'json' }, JSON.stringify(ap, null, 2));
      ta.oninput = () => { try { state.ap = JSON.parse(ta.value); ta.style.borderColor = ''; markDirty(); } catch { ta.style.borderColor = 'var(--bad)'; } };
      body.append(el('div', { class: 'card wide' }, el('h3', {}, 'Access point config (raw)'), ta));
      return;
    }
    const grid = el('div', { class: 'grid' });
    const change = (path, v) => { setPath(state.ap, path, v); markDirty(); };
    // radios
    for (const [k, v] of Object.entries(ap)) {
      if (!isBand(k, v)) continue;
      grid.append(el('div', { class: 'card' },
        el('h3', {}, (BAND_NAMES[k] || k) + ' radio', el('span', { class: 'pill ' + (v.isRadioEnabled ? 'ok' : 'bad') }, v.isRadioEnabled ? 'on' : 'off')),
        objectForm(v, [k], change, { suggest: { channel: CHANNELS[k] } })));
    }
    // band steering + any other plain objects
    for (const [k, v] of Object.entries(ap)) {
      if (isBand(k, v) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
      grid.append(el('div', { class: 'card' }, el('h3', {}, k === 'bandSteering' ? 'Band steering' : k), objectForm(v, [k], change)));
    }
    // arrays of objects (ssids, and anything else the firmware returns as a list)
    for (const [k, list] of Object.entries(ap)) {
      if (!Array.isArray(list)) continue;
      const wrap = el('div', { class: 'card wide' });
      const title = k === 'ssids' ? 'Wi-Fi networks (SSIDs)' : k;
      const addBtn = el('button', { class: 'btn small', onclick: () => { const tpl = list[0] ? deep(list[0]) : {}; if (k === 'ssids') { tpl.ssidName = 'new-network'; tpl.wpaKey = ''; tpl.guest = true; } list.push(tpl); markDirty(); draw(); } }, '+ Add');
      wrap.append(el('h3', {}, title, addBtn));
      if (!list.length) wrap.append(el('div', { class: 'muted' }, 'empty'));
      list.forEach((item, i) => {
        const del = el('button', { class: 'btn small danger', onclick: () => { if (k === 'ssids' && list.length <= 1) return toast('The gateway requires at least one network', 'bad'); list.splice(i, 1); markDirty(); draw(); } }, 'Remove');
        const label = item && typeof item === 'object' ? (item.ssidName || item.name || item.id || `${k} ${i + 1}`) + (item.guest ? '  (guest)' : '') : String(item);
        wrap.append(el('div', { class: 'card', style: 'margin-bottom:12px' }, el('h3', {}, label, del),
          item && typeof item === 'object' ? objectForm(item, [k, i], change) : fieldFor([k, i], item, (nv) => change([k, i], nv))));
      });
      grid.append(wrap);
    }
    // anything else (primitives at top level)
    const rest = Object.fromEntries(Object.entries(ap).filter(([k, v]) => !isBand(k, v) && (v === null || typeof v !== 'object')));
    if (Object.keys(rest).length) grid.append(el('div', { class: 'card' }, el('h3', {}, 'Other'), objectForm(rest, [], change)));
    body.append(grid);
  }
  function validate(ap) {
    // Same limits the stock dashboard enforces. A bad write here can strand every device on the Wi-Fi.
    const problems = [];
    for (const [i, s] of (ap.ssids || []).entries()) {
      const label = s.ssidName ? `"${s.ssidName}"` : `network ${i + 1}`;
      if (typeof s.ssidName === 'string' && (s.ssidName.length < 1 || s.ssidName.length > 28)) problems.push(`${label}: network name must be 1 to 28 characters`);
      if (typeof s.wpaKey === 'string' && (s.wpaKey.length < 8 || s.wpaKey.length > 63)) problems.push(`${label}: password must be 8 to 63 characters`);
      const bands = Object.keys(s).filter((k) => /ghzSsid$/.test(k));
      if (bands.length && !bands.some((k) => s[k])) problems.push(`${label}: pick at least one band`);
    }
    return problems;
  }
  async function save(skipConfirm) {
    if (!dirty()) return;
    const problems = validate(state.ap);
    if (problems.length) { problems.forEach((p) => toast(p, 'bad')); return; }
    if (!skipConfirm) {
      const turningOff = Object.entries(state.ap).filter(([k, v]) => isBand(k, v) && state.apOriginal?.[k]?.isRadioEnabled && !v.isRadioEnabled).map(([k]) => BAND_NAMES[k] || k);
      if (turningOff.length && !confirm(`This turns off the ${turningOff.join(' and ')} radio${turningOff.length > 1 ? 's' : ''}. Devices on that Wi-Fi will disconnect. Continue?`)) return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await api('POST', (state.apPath || '/network/configuration') + '?set=ap', state.ap);
      toast('Saved. The gateway may take up to a minute to apply.', 'ok');
      state.apOriginal = deep(state.ap);
      setTimeout(() => load(true), 6000); // G5AR returns an empty config for a few seconds after a write
    } catch (e) { toast('Save failed: ' + (e.data?.message || e.message), 'bad'); }
    markDirty();
  }
  async function setAllRadios(on) {
    if (!state.ap) return;
    if (!on && !confirm('Turn every Wi-Fi radio off? Anything on the gateway\'s Wi-Fi will disconnect.')) return;
    for (const [k, v] of Object.entries(state.ap)) if (isBand(k, v)) v.isRadioEnabled = on;
    draw(); await save(true);
  }
  load();
}

// ---------- Clients ----------
async function viewClients() {
  if (!requireAuth()) { main.append(head('Clients'), el('div', { class: 'empty' }, 'Log in to view connected devices.')); return; }
  const body = el('div');
  main.append(head('Clients', autoToggle('clients', load, 15000), el('button', { class: 'btn small', onclick: load }, 'Refresh')), body);
  async function load() {
    try {
      const r = await api('GET', '/network/telemetry?get=clients');
      const groups = r.clients || r;
      body.innerHTML = '';
      const rows = [];
      for (const [grp, list] of Object.entries(groups)) {
        if (!Array.isArray(list)) continue;
        for (const c of list) rows.push(el('tr', {},
          el('td', {}, c.name || el('span', { class: 'muted' }, 'unknown')),
          el('td', {}, el('span', { class: 'pill' }, BAND_NAMES[grp] || grp)),
          el('td', { class: 'mono' }, c.ipv4 || '—'),
          el('td', { class: 'mono' }, c.mac || '—'),
          el('td', { class: 'mono' }, c.signal != null ? c.signal + ' dBm' : '—'),
          el('td', {}, el('span', { class: 'pill ' + (c.connected === false ? 'bad' : 'ok') }, c.connected === false ? 'offline' : 'online')),
          el('td', { class: 'mono', style: 'font-size:11px' }, Array.isArray(c.ipv6) ? c.ipv6.join('\n') : (c.ipv6 || ''))));
      }
      if (!rows.length) return body.append(el('div', { class: 'empty' }, 'No clients reported.'));
      body.append(el('div', { class: 'card wide' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Name', 'Link', 'IPv4', 'MAC', 'Signal', 'State', 'IPv6'].map((h) => el('th', {}, h)))), el('tbody', {}, ...rows))));
    } catch (e) { body.innerHTML = ''; body.append(errorBox(e)); }
  }
  load();
}

// ---------- Cellular ----------
async function viewCellular() {
  if (!requireAuth()) { main.append(head('Cellular'), el('div', { class: 'empty' }, 'Log in to view cell details.')); return; }
  const body = el('div');
  main.append(head('Cellular', autoToggle('cellular', load, 10000), el('button', { class: 'btn small', onclick: load }, 'Refresh')), body);
  function flat(o, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flat(v, prefix + k + '.'));
      else out[prefix + k] = v;
    }
    return out;
  }
  function card(title, obj, badge) {
    const f = flat(obj);
    if (!Object.keys(f).length) return el('div', { class: 'card' }, el('h3', {}, title), el('div', { class: 'muted' }, 'not reported'));
    return el('div', { class: 'card' }, el('h3', {}, title, badge), kv(f, Object.keys(f).map((k) => [k, k.replace('sector.', '')])));
  }
  function radioBadge(r) {
    if (!r) return null;
    // Older firmware reports a status flag; the G5AR just omits the radio when it is not in use.
    const up = r.status !== undefined ? !!r.status : (r.rsrp != null || r.sector?.rsrp != null || (r.bands || []).length > 0);
    return el('span', { class: 'pill ' + (up ? 'ok' : 'bad') }, up ? 'connected' : 'down');
  }
  async function load() {
    try {
      const r = await api('GET', '/network/telemetry?get=all');
      const c = r.cell || {};
      body.innerHTML = '';
      body.append(el('div', { class: 'grid' },
        card('5G NR', c['5g'], radioBadge(c['5g'])),
        card('4G LTE', c['4g'], radioBadge(c['4g'])),
        card('Network', c.generic), card('SIM', r.sim), card('GPS', c.gps), card('Time', r.time || c.time)));
    } catch (e) { body.innerHTML = ''; body.append(errorBox(e)); }
  }
  load();
}

// ---------- Advanced ----------
const PRESETS = [
  ['GET', '/version', 'API version (no auth)'],
  ['GET', '/gateway?get=all', 'Device, signal, time (no auth)'],
  ['GET', '/gateway?get=signal', 'Signal only (no auth)'],
  ['GET', '/network/configuration/v2?get=ap', 'Wi-Fi config (API 1.6+, G5AR)'],
  ['POST', '/network/configuration/v2?set=ap', 'Write Wi-Fi config v2 (body = full object)'],
  ['GET', '/network/configuration/v2?delete=ap', 'Reset Wi-Fi config to defaults (v2, used by stock UI)'],
  ['GET', '/network/configuration?get=ap', 'Wi-Fi config (older firmware)'],
  ['POST', '/network/configuration?set=ap', 'Write Wi-Fi config v1 (body = full object)'],
  ['GET', '/network/telemetry?get=all', 'Cell, clients, SIM, time'],
  ['GET', '/network/telemetry?get=cell', 'Cell details'],
  ['GET', '/network/telemetry?get=clients', 'Connected clients'],
  ['GET', '/network/telemetry?get=sim', 'SIM'],
  ['POST', '/auth/refresh', 'Refresh token'],
  ['POST', '/gateway/reset?set=reboot', 'Reboot gateway'],
];
const PROBE = [
  '/version', '/gateway?get=all', '/gateway?get=signal', '/gateway?get=time', '/gateway?get=device',
  '/network/configuration/v2?get=ap', '/network/configuration?get=ap', '/network/configuration?get=lan', '/network/configuration?get=wan', '/network/configuration?get=dhcp',
  '/network/configuration?get=portforwarding', '/network/configuration?get=dmz', '/network/configuration?get=all',
  '/network/telemetry?get=all', '/network/telemetry?get=cell', '/network/telemetry?get=clients', '/network/telemetry?get=sim', '/network/telemetry?get=time',
  '/device?get=all', '/auth/admin', '/system?get=all', '/firmware?get=all',
];
async function viewAdvanced() {
  const method = el('select', {}, ...['GET', 'POST', 'PUT', 'DELETE'].map((m) => el('option', {}, m)));
  const path = el('input', { type: 'text', value: '/gateway?get=all', class: 'mono' });
  const bodyTa = el('textarea', { class: 'json', style: 'min-height:120px', placeholder: '{ } request body for POST/PUT' });
  const out = el('pre', {}, 'Response will appear here.');
  const presets = el('select', {}, el('option', { value: '' }, 'Presets…'), ...PRESETS.map((p, i) => el('option', { value: i }, `${p[0]} ${p[1]}  —  ${p[2]}`)));
  presets.onchange = () => { const p = PRESETS[presets.value]; if (!p) return; method.value = p[0]; path.value = p[1]; presets.value = ''; };
  const useAp = el('button', { class: 'btn small', onclick: () => { if (state.ap) bodyTa.value = JSON.stringify(state.ap, null, 2); else toast('Open the Wi-Fi tab first to load the config', 'bad'); } }, 'Fill body from loaded Wi-Fi config');
  async function send() {
    if (/delete=|reboot|reset|upgrade/i.test(path.value) && !confirm(`"${path.value}" looks destructive (reset, delete, reboot or upgrade). Send it anyway?`)) return;
    out.textContent = 'Sending…';
    let b;
    if (method.value !== 'GET' && bodyTa.value.trim()) { try { b = JSON.parse(bodyTa.value); } catch { return (out.textContent = 'Body is not valid JSON'); } }
    try {
      const r = await api(method.value, path.value, b);
      out.textContent = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    } catch (e) { out.textContent = `HTTP ${e.status}\n` + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2)); }
  }
  async function probe() {
    out.textContent = 'Probing ' + PROBE.length + ' endpoints…\n';
    for (const p of PROBE) {
      try { const r = await api('GET', p); out.textContent += `200  ${p}   keys: ${Object.keys(r || {}).join(', ')}\n`; }
      catch (e) { out.textContent += `${e.status || 'ERR'}  ${p}\n`; }
    }
    out.textContent += 'Done. Anything 200 that is not in the presets is a lead worth exploring.';
  }
  main.append(head('Advanced', el('button', { class: 'btn', onclick: probe }, 'Probe known endpoints')),
    el('div', { class: 'note' }, `Direct access to the gateway's local API at http://${state.meta.gateway}/TMI/v1. Paths are relative to that. Auth header is added automatically when logged in.`),
    el('div', { class: 'card wide adv' },
      el('div', { class: 'row' }, el('div', {}, 'Request'), presets),
      el('div', { class: 'row' }, method, path),
      el('div', { class: 'row' }, el('div', {}, 'Body'), el('div', {}, bodyTa, el('div', { class: 'row', style: 'margin-top:6px' }, useAp))),
      el('div', { class: 'row end' }, el('button', { class: 'btn primary', onclick: send }, 'Send'))),
    el('div', { style: 'height:14px' }),
    el('div', { class: 'card wide' }, el('h3', {}, 'Response'), out));
}

// ---------- Tools ----------
function viewTools() {
  const rebootBtn = el('button', { class: 'btn danger', onclick: async () => {
    if (!requireAuth()) return;
    if (!confirm('Reboot the gateway now? Internet drops for 2 to 3 minutes.')) return;
    try { await api('POST', '/gateway/reset?set=reboot'); toast('Reboot sent', 'ok'); setToken(null); }
    catch (e) { toast('Reboot failed: ' + (e.data?.message || e.message), 'bad'); }
  } }, 'Reboot gateway');
  const includeIds = el('input', { type: 'checkbox' });
  const SENSITIVE = /^(imei|iccid|imsi|msisdn|serial|macid|mac|wpakey|latitude|longitude|ipv6)$/i;
  const redact = (o) => Array.isArray(o) ? o.map(redact) : (o && typeof o === 'object')
    ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SENSITIVE.test(k) ? '<redacted>' : redact(v)])) : o;
  const exportBtn = el('button', { class: 'btn', onclick: async () => {
    let dump = { exportedAt: new Date().toISOString(), gateway: state.meta.gateway, redacted: !includeIds.checked };
    for (const [k, p] of [['gateway', '/gateway?get=all'], ['ap', (state.apPath || '/network/configuration/v2') + '?get=ap'], ['telemetry', '/network/telemetry?get=all']]) {
      try { dump[k] = await api('GET', p); } catch (e) { dump[k] = { error: e.message }; }
    }
    if (!includeIds.checked) dump = redact(dump);
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' })), download: `gateway-${includeIds.checked ? 'full' : 'redacted'}-${Date.now()}.json` });
    document.body.append(a); a.click(); a.remove();
  } }, 'Export as JSON');
  main.append(head('Tools'),
    el('div', { class: 'grid' },
      el('div', { class: 'card' }, el('h3', {}, 'Power'), el('p', { class: 'muted' }, 'Soft reboot via the API. Works on G4AR/KVD21 firmware; the G5AR stock dashboard has no reboot and this endpoint may answer 404 there, in which case pull the power.'), rebootBtn),
      el('div', { class: 'card' }, el('h3', {}, 'Backup / bug report'),
        el('p', { class: 'muted' }, 'Downloads device info, Wi-Fi config and telemetry as one JSON file. By default it redacts IMEI, SIM numbers, phone number, serial, MACs, Wi-Fi passwords and GPS so it is safe to attach to a bug report. Tick the box for a full backup you keep to yourself.'),
        el('label', { class: 'row', style: 'margin-bottom:10px;font-size:13px' }, includeIds, ' include identifiers and passwords (private backup)'),
        exportBtn),
      el('div', { class: 'card' }, el('h3', {}, 'Gateway web UI'), el('p', { class: 'muted' }, 'The stock dashboard, for anything this console does not cover.'), el('a', { href: `http://${state.meta.gateway}/`, target: '_blank', class: 'btn', style: 'display:inline-block;text-decoration:none' }, 'Open ' + state.meta.gateway)),
    ));
}

// ---------- boot ----------
(async function boot() {
  try { state.meta = await (await fetch('/api/_meta')).json(); } catch {}
  $('#gateway-label').textContent = state.meta.gateway + (state.meta.mock ? '  (MOCK)' : '');
  setToken(state.token);
  render();
  // Liveness heartbeat so a server started with --auto-exit stops when this window closes.
  setInterval(() => fetch('/api/_ping').catch(() => {}), 2000);
  addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/_bye'); } catch {} });
})();
