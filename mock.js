// Fake G5AR-style gateway for UI testing. Same shapes the real TMI/v1 API returns.
// Login password: "mock"

const crypto = require('crypto');

let token = null;
const state = {
  ap: {
    '2.4ghz': { airtimeFairness: true, channel: 'Auto', channelBandwidth: 'Auto', isMUMIMOEnabled: true, isRadioEnabled: true, isWMMEnabled: true, maxClients: 128, mode: 'auto', transmissionPower: '100%' },
    '5.0ghz': { airtimeFairness: true, channel: 'Auto', channelBandwidth: 'Auto', isMUMIMOEnabled: true, isRadioEnabled: true, isWMMEnabled: true, maxClients: 128, mode: 'auto', transmissionPower: '100%' },
    '6.0ghz': { airtimeFairness: true, channel: 'Auto', channelBandwidth: 'Auto', isMUMIMOEnabled: true, isRadioEnabled: true, isWMMEnabled: true, maxClients: 128, mode: 'auto', transmissionPower: '100%' },
    bandSteering: { isEnabled: true },
    ssids: [
      { '2.4ghzSsid': true, '5.0ghzSsid': true, '6.0ghzSsid': true, encryptionMode: 'AES', encryptionVersion: 'WPA2/WPA3', guest: false, isBroadcastEnabled: true, ssidName: 'HomeNetwork', wpaKey: 'mock-wifi-key-1234' },
    ],
  },
  bootTime: Date.now() - 3 * 3600 * 1000,
};

const jitter = (base, spread) => Math.round(base + (Math.random() - 0.5) * spread);

function signal() {
  return {
    '4g': { bands: ['b66'], bars: 3, cid: 12, eNBID: 123456, rsrp: jitter(-98, 6), rsrq: jitter(-11, 2), rssi: jitter(-70, 4), sinr: jitter(9, 4) },
    '5g': { bands: ['n41'], bars: 4, cid: 7, gNBID: 654321, nci: 1234567, pci: 213, rsrp: jitter(-92, 6), rsrq: jitter(-10, 2), rssi: jitter(-66, 4), sinr: jitter(16, 4) },
    generic: { apn: 'FBB.HOME', hasIPv6: true, registration: 'registered', roaming: false },
  };
}

function time() {
  return { daylightSavings: { isUsed: true }, localTime: Math.floor(Date.now() / 1000), localTimeZone: '<-06>6<-05>,M3.2.0,M11.1.0', upTime: Math.floor((Date.now() - state.bootTime) / 1000) };
}

function device() {
  return { friendlyName: '5G Gateway', hardwareVersion: 'R01', index: 1, isEnabled: true, isMeshSupported: false, macId: '00:11:22:33:44:55', manufacturer: 'Arcadyan', manufacturerOUI: '001122', model: 'TMO-G5AR', name: '5G Gateway', role: 'gateway', serial: 'MOCK0000001', softwareVersion: '1.00.18', type: 'HSID', updateState: 'latest' };
}

function cell() {
  const s = signal();
  return {
    '4g': { bandwidth: '20M', cqi: 11, earfcn: '66986', ecgi: '310260123456', mcc: '310', mnc: '260', pci: '101', plmn: '310260', sector: s['4g'], status: true, supportedBands: ['b2', 'b4', 'b5', 'b12', 'b25', 'b41', 'b66', 'b71'], tac: '12345' },
    '5g': { bandwidth: '100M', cqi: 13, earfcn: '520110', ecgi: '310260654321', mcc: '310', mnc: '260', pci: '213', plmn: '310260', sector: s['5g'], status: true, supportedBands: ['n25', 'n41', 'n71'], tac: '12345' },
    generic: s.generic,
    gps: { latitude: 0, longitude: 0 },
  };
}

function clients() {
  return {
    '2.4ghz': [{ connected: true, ipv4: '192.168.12.101', ipv6: [], mac: 'AA:BB:CC:00:00:01', name: 'thermostat', signal: -61 }],
    '5.0ghz': [{ connected: true, ipv4: '192.168.12.102', ipv6: [], mac: 'AA:BB:CC:00:00:02', name: 'phone', signal: -48 }],
    '6.0ghz': [],
    ethernet: [{ connected: true, ipv4: '192.168.12.2', ipv6: [], mac: 'AA:BB:CC:00:00:03', name: 'desktop-pc' }],
  };
}

function sim() {
  return { iccId: '8901260000000000000', imei: '000000000000000', imsi: '310260000000000', msisdn: '0000000000', status: true };
}

const ok = (body) => ({ status: 200, body });
const err = (status, msg) => ({ status, body: { result: 'error', message: msg } });

exports.handle = async function (method, p, q, bodyText, auth) {
  await new Promise((r) => setTimeout(r, 120));
  const authed = !!token && auth === `Bearer ${token}`;
  const needAuth = () => (authed ? null : err(401, 'Unauthorized'));
  let body = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { return err(400, 'bad json'); }

  if (method === 'POST' && p === '/auth/login') {
    if (body.username !== 'admin' || body.password !== 'mock') return err(401, 'Invalid credentials');
    token = crypto.randomBytes(24).toString('hex');
    return ok({ auth: { expiration: Math.floor(Date.now() / 1000) + 3600, refreshCountLeft: 4, refreshToken: crypto.randomBytes(16).toString('hex'), token } });
  }
  if (method === 'POST' && p === '/auth/refresh') {
    if (!authed) return err(401, 'Unauthorized');
    token = crypto.randomBytes(24).toString('hex');
    return ok({ auth: { expiration: Math.floor(Date.now() / 1000) + 3600, refreshCountLeft: 3, token } });
  }
  if (method === 'GET' && p === '/gateway') {
    const g = q.get('get');
    if (g === 'all') return ok({ device: device(), signal: signal(), time: time() });
    if (g === 'signal') return ok({ signal: signal() });
    if (g === 'time') return ok({ time: time() });
    return err(400, 'bad query');
  }
  if (method === 'GET' && p === '/version') return ok({ version: 3.1 });
  if (p === '/network/configuration' || p === '/network/configuration/v2') {
    const e = needAuth(); if (e) return e;
    if (method === 'GET' && q.get('get') === 'ap') return ok(JSON.parse(JSON.stringify(state.ap)));
    if (method === 'POST' && q.get('set') === 'ap') { state.ap = body; return ok({ result: 'ok' }); }
    return err(400, 'bad query');
  }
  if (method === 'GET' && p === '/network/telemetry') {
    const e = needAuth(); if (e) return e;
    const g = q.get('get');
    if (g === 'all') return ok({ cell: cell(), clients: clients(), sim: sim(), time: time() });
    if (g === 'cell') return ok({ cell: cell() });
    if (g === 'clients') return ok({ clients: clients() });
    if (g === 'sim') return ok({ sim: sim() });
    if (g === 'time') return ok({ time: time() });
    return err(400, 'bad query');
  }
  if (method === 'POST' && p === '/gateway/reset') {
    const e = needAuth(); if (e) return e;
    if (q.get('set') === 'reboot') { state.bootTime = Date.now(); token = null; return ok({ result: 'rebooting' }); }
    return err(400, 'bad query');
  }
  return err(404, `no mock for ${method} ${p}`);
};
