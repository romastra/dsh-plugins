import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { isAssignedIpv4, startSecureGateway, startHttpGatewayForTests } from './gateway.mjs';

const AUTH = 'Authorization: Bearer test-allowed\r\n';
const HOST = 'Host: phone.example:3443\r\n';
const LARGE = Buffer.alloc(2 * 1024 * 1024, 0xa5);

async function fixture(t, overrides = {}) {
  const hits = [];
  const authorized = [];
  const prepared = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer({ allowHalfOpen: true }, (req, res) => {
    const hit = { method: req.method, url: req.url, headers: req.headers, chunks: [] };
    hits.push(hit);
    req.on('data', chunk => hit.chunks.push(chunk));
    req.on('end', () => {
      hit.body = Buffer.concat(hit.chunks);
      if (req.url === '/401' || req.url === '/403') {
        res.writeHead(Number(req.url.slice(1)), { 'WWW-Authenticate': 'test-challenge', 'Set-Cookie': 'dsh-auth-private=secret' });
        res.end('never expose');
      } else if (req.url === '/large') {
        res.writeHead(200, { 'Content-Length': LARGE.length });
        res.end(LARGE);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Set-Cookie': [
          'dsh-auth-private=must-not-leak; Path=/', 'business=value; HttpOnly', 'already=safe; Secure; HttpOnly',
        ] });
        res.end(hit.body.length ? hit.body : Buffer.from('proxied'));
      }
    });
  });
  upstream.httpAllowHalfOpen = true;
  upstream.on('connection', socket => {
    upstreamSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  upstream.on('upgrade', (req, socket, head) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    socket.allowHalfOpen = true;
    if (req.url === '/401-ws') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\nSet-Cookie: dsh-auth-private=must-not-leak\r\n\r\nready');
    if (head.length) socket.write(head);
    socket.on('data', chunk => socket.write(chunk));
    socket.on('end', () => socket.end());
  });
  await new Promise(resolve => upstream.listen({ host: '127.0.0.1', port: 0 }, resolve));
  let upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = await startHttpGatewayForTests({
    host: '127.0.0.1', port: 0, quarantineMs: 1500, headerDeadlineMs: 500,
    allowPeer: ip => ip === '127.0.0.1',
    getUpstream: () => upstreamUrl,
    authorize: req => {
      authorized.push(req.url);
      if (req.url === '/?bootstrap=test') return { kind: 'bootstrap', status: 303, headers: {
        location: '/', 'set-cookie': ['dsh-auth-public=value; HttpOnly; SameSite=Strict', 'other=value; Secure'],
      } };
      return { kind: req.headers.authorization === 'Bearer test-allowed' ? 'allow' : 'deny' };
    },
    prepareUpstreamHeaders: req => {
      prepared.push(req.url);
      return { ...req.headers, host: new URL(upstreamUrl).host, origin: upstreamUrl, cookie: 'dsh-auth-private=internal-only' };
    },
    ...overrides,
  });
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.destroy();
    await gateway.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  async function raw() {
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(gateway.origin).port), allowHalfOpen: true });
    clients.add(socket);
    const chunks = [];
    let closed = false;
    let ended = false;
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', () => {});
    socket.once('end', () => { ended = true; });
    const terminalPromise = new Promise(resolve => { socket.once('end', resolve); socket.once('close', resolve); });
    const closedPromise = new Promise(resolve => socket.once('close', () => { closed = true; clients.delete(socket); resolve(); }));
    await once(socket, 'connect');
    return { socket, chunks, get closed() { return closed; }, get ended() { return ended; },
      get bytes() { return Buffer.concat(chunks); },
      async stop() { socket.destroy(); await closedPromise; await tick(); await tick(); }, closedPromise, terminalPromise };
  }
  async function request(path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(gateway.origin + path, { method, agent: false,
        headers: { host: 'phone.example:3443', authorization: 'Bearer test-allowed', ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  return { gateway, raw, request, hits, authorized, prepared, setUpstream(value) { upstreamUrl = value; } };
}

async function silent(client, milliseconds = 75) {
  await delay(milliseconds);
  assert.equal(client.bytes.length, 0, 'a rejected connection must receive ZERO HTTP bytes');
  assert.equal(client.closed || client.ended, false, 'a quarantined connection must not receive policy FIN/RST');
}

async function untilBytes(client, predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate(client.bytes)) {
    assert.ok(Date.now() < deadline, 'response deadline');
    assert.equal(client.closed, false, 'unexpected early close');
    await delay(5);
  }
  return client.bytes;
}

for (const [name, request] of [
  ['GET', `GET / HTTP/1.1\r\n${HOST}\r\n`],
  ['favicon', `GET /favicon.ico HTTP/1.1\r\n${HOST}\r\n`],
  ['HEAD', `HEAD /static/app.js HTTP/1.1\r\n${HOST}\r\n`],
  ['API', `POST /api/test HTTP/1.1\r\n${HOST}Content-Length: 4\r\n\r\nbody`],
  ['WS', `GET /socket HTTP/1.1\r\n${HOST}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`],
]) {
  test(`unauthorized ${name} is silent and held, never forwarded`, async t => {
    const f = await fixture(t);
    const client = await f.raw();
    client.socket.write(request);
    await silent(client);
    assert.equal(f.gateway.snapshot().quarantine, 1);
    assert.equal(f.hits.length, 0);
    assert.equal(f.prepared.length, 0);
  });
}

test('bootstrap is a direct empty 303 and all external cookies are Secure', async t => {
  const f = await fixture(t);
  const response = await f.request('/?bootstrap=test', { headers: { authorization: 'not-allowed' } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/');
  assert.equal(response.body.length, 0);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['set-cookie'].length, 2);
  for (const cookie of response.headers['set-cookie']) assert.match(cookie, /; Secure(?:;|$)/);
  assert.equal(f.hits.length, 0);
  assert.equal(f.prepared.length, 0);
});

test('allowed HTTP preserves raw URL and binary body; private cookies never escape', async t => {
  const f = await fixture(t);
  const body = Buffer.from([0, 255, 128, 13, 10, 0, 65]);
  const response = await f.request('/api/a%2Fb?x=%2f&x=+&z=%00', { method: 'POST', body,
    headers: { 'content-length': body.length, origin: 'https://phone.example:3443', cookie: 'outside=credential' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, body);
  assert.equal(f.hits[0].url, '/api/a%2Fb?x=%2f&x=+&z=%00');
  assert.deepEqual(f.hits[0].body, body);
  assert.equal(f.hits[0].headers.cookie, 'dsh-auth-private=internal-only');
  assert.equal(f.hits[0].headers.origin, `http://${f.hits[0].headers.host}`);
  assert.deepEqual(response.headers['set-cookie'], ['business=value; HttpOnly; Secure', 'already=safe; Secure; HttpOnly']);
  assert.equal(f.authorized.length, 1);
});

test('HEAD stays authorized and returns no response body', async t => {
  const f = await fixture(t);
  const response = await f.request('/favicon.ico', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 0);
  assert.equal(f.hits[0].method, 'HEAD');
});

test('large half-closed HTTP response drains without truncation', async t => {
  const f = await fixture(t);
  const client = await f.raw();
  client.socket.end(`GET /large HTTP/1.1\r\n${HOST}${AUTH}Connection: close\r\n\r\n`);
  await once(client.socket, 'end');
  const bytes = client.bytes;
  const split = bytes.indexOf('\r\n\r\n') + 4;
  assert.match(bytes.subarray(0, split).toString(), /^HTTP\/1.1 200/);
  assert.deepEqual(bytes.subarray(split), LARGE);
});

test('WS 101 forwards early head bytes and bidirectional binary data', async t => {
  const f = await fixture(t);
  const client = await f.raw();
  const early = Buffer.from([0x81, 0x80, 0, 1, 2, 3]);
  client.socket.write(Buffer.concat([Buffer.from(`GET /socket HTTP/1.1\r\n${HOST}${AUTH}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`), early]));
  await untilBytes(client, bytes => bytes.includes(Buffer.concat([Buffer.from('ready'), early])));
  assert.match(client.bytes.toString('latin1'), /^HTTP\/1.1 101/);
  assert.doesNotMatch(client.bytes.toString('latin1'), /dsh-auth-private/);
  const later = Buffer.from([0x82, 0x83, 0, 0xff, 0x55, 0x7f, 0, 0]);
  client.socket.write(later);
  await untilBytes(client, bytes => bytes.includes(later));
  assert.equal(f.gateway.snapshot().upgrades, 1);
  assert.equal(f.hits[0].headers.cookie, 'dsh-auth-private=internal-only');
  client.socket.end();
  await once(client.socket, 'end');
});

test('WS backpressure and client half-close drain a large binary echo without truncation', async t => {
  const f = await fixture(t);
  const client = await f.raw();
  client.socket.write(`GET /socket HTTP/1.1\r\n${HOST}${AUTH}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  await untilBytes(client, bytes => bytes.includes('ready'));
  const prefixLength = client.bytes.length;
  const end = once(client.socket, 'end');
  client.socket.pause();
  client.socket.end(LARGE);
  await delay(60);
  client.socket.resume();
  await end;
  assert.deepEqual(client.bytes.subarray(prefixLength), LARGE);
});

test('full quarantine still admits authenticating connections; overflow closes silently', async t => {
  const f = await fixture(t, { quarantineLimit: 2, quarantinePerIp: 2 });
  const first = await f.raw();
  const second = await f.raw();
  first.socket.write(`GET / HTTP/1.1\r\n${HOST}\r\n`);
  second.socket.write(`GET / HTTP/1.1\r\n${HOST}\r\n`);
  await silent(first);
  await silent(second, 20);
  assert.equal(f.gateway.snapshot().quarantine, 2);
  const allowed = await f.request('/api/allowed');
  assert.equal(allowed.status, 200);
  assert.equal(f.gateway.snapshot().quarantine, 2);
  const overflow = await f.raw();
  overflow.socket.write(`GET / HTTP/1.1\r\n${HOST}\r\n`);
  await Promise.race([overflow.terminalPromise, delay(1000).then(() => assert.fail('overflow was not closed'))]);
  assert.equal(overflow.bytes.length, 0);
  assert.equal(f.hits.length, 1);
});

for (const [name, rejected] of [
  ['invalid missing Host', 'GET /invalid HTTP/1.1\r\n\r\n'],
  ['malformed method', `INVALID! /invalid HTTP/1.1\r\n${HOST}\r\n`],
]) {
  test(`full quarantine: ${name} then valid-cookie pipeline closes terminally without forwarding`, async t => {
    const seen = [];
    const f = await fixture(t, { quarantineLimit: 1, quarantinePerIp: 1, authorize: req => {
      seen.push(req.url);
      return { kind: req.headers.cookie === 'dsh-auth-public=test-allowed' ? 'allow' : 'deny' };
    } });
    const held = await f.raw();
    held.socket.write(`GET /held HTTP/1.1\r\n${HOST}\r\n`);
    await silent(held, 30);
    assert.equal(f.gateway.snapshot().quarantine, 1);
    const overflow = await f.raw();
    overflow.socket.write(rejected +
      `GET /must-not-forward HTTP/1.1\r\n${HOST}Cookie: dsh-auth-public=test-allowed\r\n\r\n`);
    await Promise.race([overflow.terminalPromise, delay(1000).then(() => assert.fail('pipeline overflow not closed'))]);
    await delay(30);
    assert.equal(overflow.bytes.length, 0);
    assert.equal(f.hits.length, 0);
    assert.equal(f.prepared.length, 0);
    assert.deepEqual(seen, ['/held']);
    assert.equal(f.gateway.snapshot().quarantine, 1);
  });
}

test('destroyed socket after authorization cannot reach header preparation or upstream', async t => {
  const f = await fixture(t, { authorize: req => { req.socket.destroy(); return { kind: 'allow' }; } });
  const client = await f.raw();
  client.socket.write(`GET /must-not-forward HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await Promise.race([client.terminalPromise, delay(1000).then(() => assert.fail('destroyed client not closed'))]);
  await delay(30);
  assert.equal(client.bytes.length, 0);
  assert.equal(f.prepared.length, 0);
  assert.equal(f.hits.length, 0);
});

test('destroyed socket after async header preparation cannot reach upstream', async t => {
  const f = await fixture(t, { prepareUpstreamHeaders: async req => {
    req.socket.destroy(); return { host: '127.0.0.1' };
  } });
  const client = await f.raw();
  client.socket.write(`GET /must-not-forward HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await Promise.race([client.terminalPromise, delay(1000).then(() => assert.fail('destroyed client not closed'))]);
  await delay(30);
  assert.equal(client.bytes.length, 0);
  assert.equal(f.hits.length, 0);
});

test('default per-IP budget is three and authorized traffic does not consume it', async t => {
  const f = await fixture(t);
  const denied = [];
  for (let i = 0; i < 3; i++) {
    const client = await f.raw(); denied.push(client);
    client.socket.write(`GET /bad-${i} HTTP/1.1\r\n${HOST}\r\n`);
    await silent(client, 30);
  }
  const fourth = await f.raw();
  fourth.socket.write(`GET /bad HTTP/1.1\r\n${HOST}\r\n`);
  await Promise.race([fourth.terminalPromise, delay(1000).then(() => assert.fail('per-IP overflow not closed'))]);
  assert.equal(fourth.bytes.length, 0);
  assert.equal((await f.request('/')).status, 200);
  assert.equal(f.gateway.snapshot().quarantine, 3);
});

for (const [name, wire] of [
  ['malformed method', 'INVALID! / HTTP/1.1\r\nHost: phone.example\r\n\r\n'],
  ['missing Host', `GET / HTTP/1.1\r\n${AUTH}\r\n`],
  ['empty Host', `GET / HTTP/1.1\r\nHost: \r\n${AUTH}\r\n`],
  ['duplicate Host', `GET / HTTP/1.1\r\n${HOST}${HOST}${AUTH}\r\n`],
  ['duplicate Content-Length', `POST / HTTP/1.1\r\n${HOST}${AUTH}Content-Length: 1\r\nContent-Length: 1\r\n\r\na`],
  ['CL plus TE', `POST / HTTP/1.1\r\n${HOST}${AUTH}Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`],
  ['oversized header', `GET / HTTP/1.1\r\n${HOST}X-Large: ${'x'.repeat(17000)}\r\n\r\n`],
  ['Expect continue', `POST / HTTP/1.1\r\n${HOST}Expect: 100-continue\r\nContent-Length: 5\r\n\r\n`],
  ['Expect unknown', `GET / HTTP/1.1\r\n${HOST}Expect: magic\r\n\r\n`],
  ['CONNECT', `CONNECT 127.0.0.1:1 HTTP/1.1\r\n${HOST}${AUTH}\r\n`],
  ['PRI HTTP1', `PRI / HTTP/1.1\r\n${HOST}${AUTH}\r\n`],
  ['H2 preface', 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'],
  ['absolute-form', `GET http://127.0.0.1:123/ HTTP/1.1\r\n${HOST}${AUTH}\r\n`],
  ['protected Connection tokens', `GET / HTTP/1.1\r\n${HOST}${AUTH}Connection: host, origin, cookie\r\n\r\n`],
]) {
  test(`${name} is silently quarantined without Node automatic error responses`, async t => {
    const f = await fixture(t);
    const client = await f.raw();
    client.socket.write(wire);
    await silent(client);
    assert.equal(f.hits.length, 0);
    assert.equal(f.gateway.snapshot().quarantine, 1);
  });
}

test('header deadline produces no 408 and quarantine ends only at its deadline', async t => {
  const f = await fixture(t, { headerDeadlineMs: 30, quarantineMs: 180 });
  const client = await f.raw();
  client.socket.write('GET / HTTP/1.1\r\nHo');
  await silent(client, 70);
  assert.equal(f.gateway.snapshot().quarantine, 1);
  await Promise.race([client.terminalPromise, delay(1000).then(() => assert.fail('quarantine expiry did not close'))]);
  assert.equal(client.bytes.length, 0);
});

test('pending-header concurrency is bounded separately from quarantine', async t => {
  const f = await fixture(t, { maxPendingHeaders: 1 });
  const stalled = await f.raw();
  stalled.socket.write('GET / HTTP/1.1\r\n');
  const excess = await f.raw();
  excess.socket.write(`GET /invalid HTTP/1.1\r\n\r\nGET /valid HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await Promise.race([excess.terminalPromise, delay(1000).then(() => assert.fail('header overflow not closed'))]);
  assert.equal(excess.bytes.length, 0);
  assert.equal(f.gateway.snapshot().pendingHeaders, 1);
  assert.equal(f.gateway.snapshot().quarantine, 0);
  assert.equal(f.authorized.length, 0);
  assert.equal(f.prepared.length, 0);
  assert.equal(f.hits.length, 0);
});

test('invalid then valid pipelined requests never reach upstream, including async authorizer', async t => {
  const seen = [];
  const f = await fixture(t, { authorize: async req => {
    seen.push(req.url);
    await delay(30);
    return { kind: req.headers.authorization ? 'allow' : 'deny' };
  } });
  const client = await f.raw();
  client.socket.write(`GET /invalid HTTP/1.1\r\n${HOST}\r\nGET /valid HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await silent(client, 100);
  assert.deepEqual(seen, ['/invalid']);
  assert.equal(f.hits.length, 0);
  assert.equal(f.prepared.length, 0);
});

test('partial valid pipeline after rejection is discarded rather than later forwarded', async t => {
  const f = await fixture(t);
  const client = await f.raw();
  client.socket.write(`GET /invalid HTTP/1.1\r\n${HOST}\r\nGET /valid HTTP/1.1\r\nHo`);
  await silent(client, 30);
  client.socket.write(`st: phone.example:3443\r\n${AUTH}\r\n`);
  await silent(client, 60);
  assert.equal(f.hits.length, 0);
  assert.deepEqual(f.authorized, ['/invalid']);
});

test('every keep-alive request is reauthorized; later rejection seals the entire connection', async t => {
  const f = await fixture(t);
  const client = await f.raw();
  client.socket.write(`GET /first HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await untilBytes(client, bytes => bytes.includes('proxied'));
  const before = client.bytes.length;
  client.socket.write(`GET /second HTTP/1.1\r\n${HOST}\r\nGET /third HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await delay(100);
  assert.equal(client.bytes.length, before);
  assert.equal(client.closed, false);
  assert.deepEqual(f.authorized, ['/first', '/second']);
  assert.equal(f.hits.length, 1);
});

for (const route of ['/401', '/403', '/401-ws']) {
  test(`upstream ${route} is suppressed without challenges or cookie leaks`, async t => {
    const f = await fixture(t);
    const client = await f.raw();
    client.socket.write(`GET ${route} HTTP/1.1\r\n${HOST}${AUTH}${route.endsWith('ws') ? 'Upgrade: websocket\r\nConnection: Upgrade\r\n' : ''}\r\n`);
    await silent(client);
    assert.equal(f.hits.length, 1);
    assert.equal(f.gateway.snapshot().quarantine, 1);
  });
}

test('throwing or rejecting authorization fails closed without unhandled errors', async t => {
  const f = await fixture(t, { authorize: async () => { throw new Error('secret in callback'); },
    onEvent: event => { assert.deepEqual(Object.keys(event), ['type']); throw new Error('observer'); } });
  const client = await f.raw();
  client.socket.write(`GET /secret-url HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await silent(client);
  assert.equal(f.hits.length, 0);
});

test('hung authorizers remain bounded by maxPendingAuth even after deadline', async t => {
  let calls = 0;
  const f = await fixture(t, { maxPendingAuth: 1, headerDeadlineMs: 40, authorize: () => {
    calls++; return new Promise(() => {});
  } });
  const first = await f.raw();
  first.socket.write(`GET / HTTP/1.1\r\n${HOST}\r\n`);
  await silent(first, 80);
  const second = await f.raw();
  second.socket.write(`GET / HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await silent(second, 30);
  assert.equal(calls, 1);
  assert.equal(f.gateway.snapshot().pendingAuth, 1);
  await f.gateway.close();
  assert.equal(f.gateway.snapshot().pendingAuth, 0);
});

test('changed or unsafe upstream fails closed before forwarding', async t => {
  const f = await fixture(t);
  f.setUpstream('http://127.0.0.1:1');
  const client = await f.raw();
  client.socket.write(`GET / HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await silent(client);
  assert.equal(f.hits.length, 0);
});

test('close awaits quarantined, header, active upgrade and upstream sockets; is idempotent', async t => {
  const f = await fixture(t);
  const denied = await f.raw();
  denied.socket.write(`GET / HTTP/1.1\r\n${HOST}\r\n`);
  const headers = await f.raw();
  headers.socket.write('GET / HTTP/1.1\r\n');
  const ws = await f.raw();
  ws.socket.write(`GET /socket HTTP/1.1\r\n${HOST}${AUTH}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  await untilBytes(ws, bytes => bytes.includes('ready'));
  await f.gateway.close();
  await f.gateway.close();
  assert.deepEqual(f.gateway.snapshot(), { closing: true, connections: 0, sockets: 0, quarantine: 0,
    quarantineIps: 0, pendingTls: 0, pendingHeaders: 0, pendingAuth: 0, timers: 0, upgrades: 0 });
});

test('production accepts any assigned unicast adapter IP but not wildcards or nonlocal addresses', async () => {
  const interfaces = { Virtual: [{ family: 'IPv4', internal: false, address: '26.1.2.3' }],
    APIPA: [{ family: 'IPv4', internal: false, address: '169.254.1.2' }],
    Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] };
  for (const host of ['26.1.2.3', '169.254.1.2', '127.0.0.1']) assert.equal(isAssignedIpv4(host, interfaces), true);
  for (const host of ['0.0.0.0', '::', '224.1.2.3', '8.8.8.8', 'localhost']) assert.equal(isAssignedIpv4(host, interfaces), false);
  for (const host of ['0.0.0.0', '::', '8.8.8.8']) {
    await assert.rejects(startSecureGateway({ host }), /assigned unicast IPv4/);
  }
  await assert.rejects(startSecureGateway({ host: '127.0.0.1' }), /PFX/);
  await assert.rejects(startHttpGatewayForTests({ host: '0.0.0.0' }), /loopback/);
});

test('allowed Expect 100-continue is emitted only after authorization, then proxies the body', async t => {
  let decided = false;
  const f = await fixture(t, { authorize: async () => {
    await delay(30); decided = true; return { kind: 'allow' };
  } });
  const client = await f.raw();
  client.socket.write(`POST /expect HTTP/1.1\r\n${HOST}${AUTH}Expect: 100-continue\r\nContent-Length: 4\r\n\r\n`);
  await delay(10);
  assert.equal(client.bytes.length, 0);
  await untilBytes(client, bytes => bytes.includes('100 Continue'));
  assert.equal(decided, true);
  client.socket.write('body');
  await untilBytes(client, bytes => bytes.includes('body'));
  assert.match(client.bytes.toString(), /HTTP\/1.1 200/);
  assert.equal(f.hits[0].body.toString(), 'body');
});

test('bounded allowed HTTP pipelining authorizes each request in response order', async t => {
  const f = await fixture(t);
  const client = await f.raw();
  client.socket.write(`GET /one HTTP/1.1\r\n${HOST}${AUTH}\r\nGET /two HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await untilBytes(client, bytes => (bytes.toString().match(/HTTP\/1.1 200/g) || []).length === 2);
  assert.deepEqual(f.authorized, ['/one', '/two']);
  assert.deepEqual(f.hits.map(hit => hit.url), ['/one', '/two']);
});

test('pipeline flood is bounded and quarantined before any forwarding', async t => {
  const f = await fixture(t, { maxQueuedRequests: 2, authorize: async () => {
    await delay(30); return { kind: 'allow' };
  } });
  const client = await f.raw();
  client.socket.write(Array.from({ length: 64 }, (_, index) =>
    `GET /${index} HTTP/1.1\r\n${HOST}${AUTH}\r\n`).join(''));
  await silent(client, 100);
  assert.equal(f.hits.length, 0);
  assert.equal(f.gateway.snapshot().quarantine, 1);
});

test('a throwing decision getter is contained rather than escaping the async handler', async t => {
  const f = await fixture(t, { authorize: () => Object.defineProperty({}, 'kind', {
    get() { throw new Error('private authorization failure'); },
  }) });
  const client = await f.raw();
  client.socket.write(`GET / HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await silent(client);
  assert.equal(f.hits.length, 0);
});

test('close disposes a pending authorizer and prepare hook without waiting for foreign promises', async t => {
  const f = await fixture(t, { prepareUpstreamHeaders: () => new Promise(() => {}) });
  const client = await f.raw();
  client.socket.write(`GET / HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await delay(30);
  await f.gateway.close();
  assert.equal(f.gateway.snapshot().sockets, 0);
  assert.equal(f.gateway.snapshot().timers, 0);
  assert.equal(f.hits.length, 0);
});

test('unknown HTTP peer half-close receives neither HTTP bytes nor policy FIN during quarantine', async t => {
  const f = await fixture(t, { quarantineMs: 300 });
  const client = await f.raw();
  client.socket.end(`GET /unknown HTTP/1.1\r\n${HOST}\r\n`);
  await silent(client, 120);
  assert.equal(f.gateway.snapshot().quarantine, 1);
  assert.equal(f.hits.length, 0);
});

test('authorized keep-alive idle beyond header deadline is not quarantined; next bad request still is', async t => {
  const f = await fixture(t, { headerDeadlineMs: 30, authorizedIdleMs: 500 });
  const client = await f.raw();
  client.socket.write(`GET /first HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await untilBytes(client, bytes => bytes.includes('proxied'));
  const length = client.bytes.length;
  await delay(90);
  assert.equal(client.closed || client.ended, false);
  assert.equal(f.gateway.snapshot().quarantine, 0);
  assert.equal(f.gateway.snapshot().pendingHeaders, 0);
  client.socket.write(`GET /rejected HTTP/1.1\r\n${HOST}\r\n`);
  await delay(60);
  assert.equal(client.bytes.length, length);
  assert.equal(client.closed || client.ended, false);
  assert.equal(f.gateway.snapshot().quarantine, 1);
  assert.deepEqual(f.authorized, ['/first', '/rejected']);
});

test('authenticated partial keep-alive headers use bounded normal idle-close, not quarantine', async t => {
  const f = await fixture(t, { headerDeadlineMs: 30, authorizedIdleMs: 160 });
  const client = await f.raw();
  client.socket.write(`GET /first HTTP/1.1\r\n${HOST}${AUTH}\r\n`);
  await untilBytes(client, bytes => bytes.includes('proxied'));
  const length = client.bytes.length;
  client.socket.write('GET /partial HTTP/1.1\r\nHo');
  await delay(70);
  assert.equal(client.closed || client.ended, false);
  assert.equal(f.gateway.snapshot().quarantine, 0);
  await Promise.race([client.terminalPromise, delay(1000).then(() => assert.fail('authorized idle close missing'))]);
  assert.equal(client.bytes.length, length);
  assert.equal(f.gateway.snapshot().quarantine, 0);
  assert.equal(f.hits.length, 1);
});

test('upstream startup accepts only fixed plain HTTP numeric IPv4 127/8', async () => {
  for (const url of ['https://127.0.0.1:1', 'http://localhost:1', 'http://192.168.1.1:1',
    'http://127.0.0.1:1/path', 'http://user@127.0.0.1:1', 'http://127.0.0.1:1/?secret=x', 'http://[::1]:1']) {
    await assert.rejects(startHttpGatewayForTests({ host: '127.0.0.1', getUpstream: () => url,
      authorize: () => ({ kind: 'deny' }), prepareUpstreamHeaders: () => ({}), allowPeer: () => true }), /upstream/);
  }
});
