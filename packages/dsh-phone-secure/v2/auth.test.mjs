import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createDshAuthorizer, isTrustedPublicRequest } from './auth.mjs';

const PUBLIC = 'https://192.168.242.8:3443';
const INNER = 'http://127.0.0.1:50195';
function cookieFor(authority) {
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
  const value = createHmac('sha256', 'unit-fixture-not-a-real-secret').update(authority).digest('base64url');
  return `${name}=${value}`;
}
function request(path = '/', headers = {}, method = 'GET') {
  const all = { host: new URL(PUBLIC).host, ...headers };
  return { method, url: path, headers: all, rawHeaders: Object.entries(all).flat() };
}
function fakeConnection() {
  return {
    disposed: false,
    calls: 0,
    authenticatedUrl(base) { const url = new URL(base); url.searchParams.set('token', 'unit-token'); return url.href; },
    requestRejection(req) {
      if (this.disposed) return 401;
      if (req.headers.host !== new URL(INNER).host) return 403;
      return req.headers.cookie === cookieFor(new URL(INNER).host) ? undefined : 401;
    },
    authorizeIndex(req, res) {
      this.calls++;
      const url = new URL(req.url, 'http://unused.invalid');
      const validCookie = req.headers.cookie === cookieFor(req.headers.host);
      if (url.searchParams.has('token')) {
        if (req.method === 'GET' && url.pathname === '/' && url.searchParams.getAll('token').length === 1 && url.searchParams.get('token') === 'unit-token') {
          res.writeHead(303, { location: './', 'set-cookie': `${cookieFor(req.headers.host)}; HttpOnly; SameSite=Strict` }); res.end(); return false;
        }
        if (req.method === 'GET' && url.pathname === '/' && validCookie) { res.writeHead(303, { location: './' }); res.end(); return false; }
        res.writeHead(401); res.end(); return false;
      }
      if (validCookie) return true;
      res.writeHead(401); res.end(); return false;
    },
  };
}
function fixture() {
  const connection = fakeConnection();
  const adapter = createDshAuthorizer({ connection, publicOrigin: PUBLIC, getUpstream: () => INNER });
  return { connection, adapter };
}

test('outer trust is exact and separate from native cookie checking', () => {
  assert.equal(isTrustedPublicRequest(request(), PUBLIC), true);
  assert.equal(isTrustedPublicRequest(request('/', { origin: PUBLIC }), PUBLIC), true);
  for (const req of [request('/', { host: '127.0.0.1:50195' }), request('/', { origin: 'https://evil.invalid' }),
    request('/', { 'sec-fetch-site': 'cross-site' }), request('//evil.invalid/'), request('/?token=a&token=b'),
    { ...request(), rawHeaders: ['Host', new URL(PUBLIC).host, 'Host', new URL(PUBLIC).host] }]) {
    assert.equal(isTrustedPublicRequest(req, PUBLIC), false);
  }
});

test('missing, random and old HTTP-port credentials deny on every resource', () => {
  const { adapter } = fixture();
  for (const path of ['/', '/favicon.ico', '/plugins/a/client.js', '/api/remote.mux']) {
    assert.equal(adapter.authorize(request(path)).kind, 'deny');
    assert.equal(adapter.authorize(request(path, { cookie: cookieFor('192.168.242.8:3080') })).kind, 'deny');
  }
  assert.equal(adapter.authorize(request('/?token=wrong')).kind, 'deny');
});

test('only a successful native root login bootstraps, without leaking the internal cookie', () => {
  const { adapter } = fixture();
  const decision = adapter.authorize(request('/?token=unit-token'));
  assert.equal(decision.kind, 'bootstrap');
  assert.equal(decision.status, 303);
  assert.ok(decision.headers['set-cookie'][0].startsWith(cookieFor(new URL(PUBLIC).host)));
  assert.ok(!JSON.stringify(decision).includes(cookieFor(new URL(INNER).host)));
  assert.equal(adapter.authorize(request('/api?token=unit-token')).kind, 'deny');
  assert.equal(adapter.authorize(request('/?token=unit-token', {}, 'POST')).kind, 'deny');
});

test('native cookie permits every request, private canonical forwarding follows the positive decision', () => {
  const { adapter } = fixture();
  const req = request('/api/test', { cookie: cookieFor(new URL(PUBLIC).host), origin: PUBLIC,
    'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil.invalid', forwarded: 'host=evil.invalid', referer: PUBLIC + '/?token=hidden' }, 'POST');
  assert.equal(adapter.authorize(req).kind, 'allow');
  const headers = adapter.prepareUpstreamHeaders(req);
  assert.equal(headers.host, new URL(INNER).host);
  assert.equal(headers.origin, INNER);
  assert.equal(headers.cookie, cookieFor(new URL(INNER).host));
  assert.equal(headers['x-forwarded-for'], undefined);
  assert.equal(headers.forwarded, undefined);
  assert.equal(headers.referer, undefined);
  assert.equal(adapter.authorize(request('/api/test')).kind, 'deny');
});

test('the forwarding adapter independently refuses missing, random and bootstrap-only credentials', () => {
  const { adapter } = fixture();
  assert.throws(() => adapter.prepareUpstreamHeaders(request('/api/test')));
  assert.throws(() => adapter.prepareUpstreamHeaders(request('/api/test', { cookie: 'random=value' })));
  assert.throws(() => adapter.prepareUpstreamHeaders(request('/?token=unit-token')));
  assert.ok(adapter.prepareUpstreamHeaders(request('/api/test', { cookie: cookieFor(new URL(PUBLIC).host) })).cookie);
});

test('a valid existing native cookie can clean a bad launch URL without issuing a new cookie', () => {
  const { adapter } = fixture();
  const decision = adapter.authorize(request('/?token=bad', { cookie: cookieFor(new URL(PUBLIC).host) }));
  assert.equal(decision.kind, 'bootstrap');
  assert.equal(decision.headers['set-cookie'], undefined);
});

test('correct tokens cannot bypass Host/Origin and disposed/lifetime boundaries', () => {
  const { connection, adapter } = fixture();
  assert.equal(adapter.authorize(request('/?token=unit-token', { origin: 'https://evil.invalid' })).kind, 'deny');
  connection.disposed = true;
  assert.equal(adapter.authorize(request('/?token=unit-token')).kind, 'deny');
  adapter.destroy();
  assert.equal(adapter.authorize(request('/?token=unit-token')).kind, 'deny');
  assert.throws(() => adapter.prepareUpstreamHeaders(request()));
});

test('no non-loopback upstream and no insecure public origin', () => {
  assert.throws(() => createDshAuthorizer({ connection: fakeConnection(), publicOrigin: 'http://192.168.242.8:3443', getUpstream: () => INNER }));
  const adapter = createDshAuthorizer({ connection: fakeConnection(), publicOrigin: PUBLIC, getUpstream: () => 'http://192.168.242.1:80' });
  assert.equal(adapter.authorize(request('/?token=unit-token')).kind, 'deny');
});
