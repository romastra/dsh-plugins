import http from 'node:http';
import https from 'node:https';
import { createConnection, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isBindableIpv4 } from './net-policy.mjs';

const noop = () => {};
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function integer(value, fallback, min, max, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`gateway: invalid ${name}`);
  }
  return value;
}

function limits(options) {
  return {
    quarantineLimit: integer(options.quarantineLimit, 10, 0, 10, 'quarantineLimit'),
    quarantinePerIp: integer(options.quarantinePerIp, 3, 1, 3, 'quarantinePerIp'),
    quarantineMs: integer(options.quarantineMs, 120000, 1, 120000, 'quarantineMs'),
    headerDeadlineMs: integer(options.headerDeadlineMs, 10000, 1, 10000, 'headerDeadlineMs'),
    maxHeaderBytes: integer(options.maxHeaderBytes, 16384, 256, 16384, 'maxHeaderBytes'),
    maxPendingAuth: integer(options.maxPendingAuth, 32, 1, 32, 'maxPendingAuth'),
    maxPendingTls: integer(options.maxPendingTls, 32, 1, 32, 'maxPendingTls'),
    maxPendingHeaders: integer(options.maxPendingHeaders, 32, 1, 128, 'maxPendingHeaders'),
    maxConnections: integer(options.maxConnections, 128, 1, 1024, 'maxConnections'),
    maxQueuedRequests: integer(options.maxQueuedRequests, 4, 1, 16, 'maxQueuedRequests'),
    authorizedIdleMs: integer(options.authorizedIdleMs, 60000, 1, 120000, 'authorizedIdleMs'),
  };
}

function loopbackDestination(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) throw new TypeError('gateway: invalid upstream');
  const url = new URL(value);
  if (url.protocol !== 'http:' || !isIPv4(url.hostname) || !url.hostname.startsWith('127.') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('gateway: upstream must be fixed HTTP IPv4 loopback');
  }
  const port = integer(Number(url.port || 80), 80, 1, 65535, 'upstream port');
  return { host: url.hostname, port, key: `${url.hostname}:${port}` };
}

export function isAssignedIpv4(host, interfaces = networkInterfaces()) {
  return isBindableIpv4(host) && Object.values(interfaces).flat().some(item => item &&
    item.family === 'IPv4' && item.address === host);
}

function normalizedIp(ip) { return typeof ip === 'string' ? ip.replace(/^::ffff:/, '') : ''; }
function socketKey(socket) { return `${socket.remoteAddress}|${socket.remotePort}|${socket.localAddress}|${socket.localPort}`; }

function validRequest(req, upgrade) {
  if (req.httpVersionMajor !== 1 || ![0, 1].includes(req.httpVersionMinor) ||
      req.method === 'CONNECT' || req.method === 'PRI' || typeof req.url !== 'string' ||
      !req.url.startsWith('/') || req.url.startsWith('//') || /[\x00-\x20\x7f]/.test(req.url)) return false;
  const hosts = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host');
  if (hosts.length !== 1 || typeof req.headers.host !== 'string' ||
      !/^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+)(?::[0-9]{1,5})?$/.test(req.headers.host)) return false;
  try { new URL(`http://${req.headers.host}`); } catch { return false; }
  const connectionTokens = String(req.headers.connection || '').toLowerCase().split(/\s*,\s*/).filter(Boolean);
  if (connectionTokens.some(name => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      ['host', 'origin', 'cookie', 'authorization', 'content-length', 'transfer-encoding'].includes(name))) return false;
  if (upgrade && (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !String(req.headers.connection || '').toLowerCase().split(/\s*,\s*/).includes('upgrade'))) return false;
  return true;
}

function checkedHeaders(input, { upgrade = false, response = false, secureCookies = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('gateway: invalid headers');
  const output = Object.create(null);
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (Object.hasOwn(output, lower)) throw new TypeError('gateway: duplicate prepared header');
    http.validateHeaderName(name);
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.some(item => !['string', 'number'].includes(typeof item))) {
      throw new TypeError('gateway: invalid header value');
    }
    for (const item of values) http.validateHeaderValue(name, item);
    output[lower] = Array.isArray(value) ? values.map(String) : String(value);
  }
  const nominated = String(output.connection || '').toLowerCase().split(/\s*,\s*/);
  for (const name of nominated) if (name && name !== 'upgrade') delete output[name];
  for (const name of HOP) delete output[name];
  if ((response || secureCookies) && output['set-cookie'] !== undefined) {
    let cookies = Array.isArray(output['set-cookie']) ? output['set-cookie'] : [output['set-cookie']];
    if (response && !secureCookies) cookies = cookies.filter(cookie => !/^\s*dsh-auth-/i.test(cookie));
    if (cookies.length) {
      output['set-cookie'] = cookies.map(cookie => /;\s*secure\s*(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`);
    } else delete output['set-cookie'];
  }
  if (upgrade) {
    output.connection = 'Upgrade';
    output.upgrade = 'websocket';
    delete output['content-length'];
  }
  return output;
}

/**
 * HTTPS-only production entry. Any adapter is permitted; Node independently
 * verifies that the exact unicast IPv4 is assigned locally. Never bind a wildcard.
 * authorize(req) is the ONLY credential authority; no cookie cryptography lives here.
 * prepareUpstreamHeaders(req) must return an object and runs only after kind:'allow'.
 * getUpstream() is synchronous and pinned to the initial HTTP 127/8 host + port.
 */
export async function startSecureGateway(options) {
  if (!options || !isAssignedIpv4(options.host)) throw new TypeError('gateway: explicit assigned unicast IPv4 required');
  if (!options.tlsOptions || (!Buffer.isBuffer(options.tlsOptions.pfx) && !(options.tlsOptions.pfx instanceof Uint8Array)) ||
      (options.tlsOptions.passphrase !== undefined && typeof options.tlsOptions.passphrase !== 'string')) {
    throw new TypeError('gateway: PFX bytes and optional passphrase required');
  }
  return start(options, true);
}

/** Test seam: deliberately HTTP, restricted to loopback. Never use for LAN exposure. */
export async function startHttpGatewayForTests(options) {
  if (options?.host !== '127.0.0.1') throw new TypeError('gateway: test listener must be loopback');
  return start(options, false);
}

async function start(options, secure) {
  const config = limits(options);
  const port = integer(options.port, 63819, 0, 65535, 'port');
  for (const name of ['authorize', 'getUpstream', 'prepareUpstreamHeaders', 'allowPeer']) {
    if (typeof options[name] !== 'function') throw new TypeError(`gateway: ${name} callback required`);
  }
  const destination = loopbackDestination(options.getUpstream());
  const serverOptions = {
    allowHalfOpen: true, requireHostHeader: false, maxHeaderSize: config.maxHeaderBytes,
    highWaterMark: 16384, headersTimeout: 0, requestTimeout: 0, keepAliveTimeout: 0,
    connectionsCheckingInterval: 1000,
  };
  const server = secure ? https.createServer({
    ...serverOptions,
    pfx: options.tlsOptions.pfx, passphrase: options.tlsOptions.passphrase,
    minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'],
    handshakeTimeout: config.headerDeadlineMs,
    // No user-controlled TLS callbacks or HTTP/2 negotiation enter the transport.
  }) : http.createServer(serverOptions);
  server.httpAllowHalfOpen = true;
  server.maxRequestsPerSocket = 0; // A nonzero value causes Node's automatic 503.
  server.maxHeadersCount = 0; // Never silently truncate security-relevant headers.
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 0;
  server.timeout = 0;
  server.maxConnections = config.maxConnections;

  const states = new Set();
  const bySocket = new WeakMap();
  const byKey = new Map();
  const sockets = new Set();
  const timers = new Set();
  const quarantinedByIp = new Map();
  const authTokens = new Set();
  let quarantined = 0;
  let pendingTls = 0;
  let pendingHeaders = 0;
  let closing = false;
  let closePromise;

  function emit(type) {
    // Deliberately no URL, headers, cookie, token, peer address, exception or TLS details.
    try { options.onEvent?.({ type }); } catch { /* Observability cannot affect policy. */ }
  }
  function timer(fn, ms) {
    const handle = setTimeout(() => { timers.delete(handle); fn(); }, ms);
    handle.unref();
    timers.add(handle);
    return handle;
  }
  function untimer(handle) { if (handle) { clearTimeout(handle); timers.delete(handle); } }
  function track(socket) {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.on('error', noop);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  }
  function clearHeader(state) {
    untimer(state.headerTimer);
    untimer(state.idleTimer);
    state.headerTimer = undefined;
    state.idleTimer = undefined;
    if (state.pendingHeader) { state.pendingHeader = false; pendingHeaders--; }
  }
  function headerWait(state) {
    if (closing || state.closed || state.socket.destroyed || state.quarantined || state.busy || state.queue.length || state.upgraded) return;
    // Authenticated keep-alive is not an unknown credential attempt. Normal
    // idle close bounds subsequent slow/partial headers without consuming the
    // quarantine pool or imposing a 10-second timeout on healthy idle browsers.
    if (state.everAllowed) {
      if (!state.idleTimer) state.idleTimer = timer(() => state.socket.destroy(), config.authorizedIdleMs);
      return;
    }
    if (state.pendingHeader) return;
    if (pendingHeaders >= config.maxPendingHeaders) {
      release(state);
      state.socket.destroy();
      emit('header-budget');
      return;
    }
    state.pendingHeader = true;
    pendingHeaders++;
    state.headerTimer = timer(() => quarantine(state, 'header-deadline'), config.headerDeadlineMs);
  }
  function release(state) {
    if (state.closed) return;
    state.closed = true;
    clearHeader(state);
    untimer(state.tlsTimer);
    untimer(state.quarantineTimer);
    if (state.pendingTls) { state.pendingTls = false; pendingTls--; }
    if (state.quarantined) {
      quarantined--;
      const count = quarantinedByIp.get(state.ip) - 1;
      if (count) quarantinedByIp.set(state.ip, count); else quarantinedByIp.delete(state.ip);
    }
    for (const cancel of state.cancels) cancel();
    state.cancels.clear();
    state.queue.length = 0;
    states.delete(state);
    byKey.delete(state.key);
  }
  function quarantine(state, reason) {
    if (!state || state.closed || state.socket.destroyed || state.quarantined || closing) return;
    clearHeader(state);
    untimer(state.tlsTimer);
    state.queue.length = 0;
    const count = quarantinedByIp.get(state.ip) || 0;
    if (quarantined >= config.quarantineLimit || count >= config.quarantinePerIp) {
      // Mark terminal and cancel queued/upstream work before native parser or
      // promise continuations can run again; socket 'close' is asynchronous.
      release(state);
      state.socket.destroy();
      emit('quarantine-budget');
      return;
    }
    state.quarantined = true;
    quarantined++;
    quarantinedByIp.set(state.ip, count + 1);
    for (const cancel of state.cancels) cancel();
    state.cancels.clear();
    const socket = state.socket;
    // Admission's data listener already unconsumed Node's native parser. Detach
    // parsing and PAUSE: neither arbitrary attacker bytes nor pipelines are
    // drained forever. Even a peer half-close must not close our writable side.
    // A bounded socket/kernel receive buffer supplies backpressure until expiry.
    socket.removeAllListeners('data');
    socket.removeAllListeners('end');
    socket.on('end', noop);
    socket.on('resume', () => socket.pause());
    socket.setTimeout(0);
    socket.pause();
    state.quarantineTimer = timer(() => socket.destroy(), config.quarantineMs);
    emit(reason);
  }
  function admitSocket(socket, state) {
    state.socket = socket;
    bySocket.set(socket, state);
    track(socket);
    socket.allowHalfOpen = true;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    // This public listener also disables the native parser's direct handle consume
    // optimization, making parser detachment on quarantine reliable in Node 24.
    socket.on('data', noop);
    socket.once('close', () => release(state));
    headerWait(state);
  }
  server.prependListener('connection', raw => {
    track(raw);
    raw.allowHalfOpen = true;
    if (closing || states.size >= config.maxConnections || (secure && pendingTls >= config.maxPendingTls)) {
      raw.destroy(); emit('connection-budget'); return;
    }
    let peerAllowed = false;
    try { peerAllowed = options.allowPeer(normalizedIp(raw.remoteAddress)) === true; } catch { /* Deny. */ }
    if (!peerAllowed) { raw.destroy(); emit('peer-denied'); return; }
    const state = {
      raw, socket: raw, key: socketKey(raw), ip: normalizedIp(raw.remoteAddress),
      queue: [], cancels: new Set(), busy: false, closed: false, quarantined: false,
      pendingTls: secure, pendingHeader: false, upgraded: false,
    };
    states.add(state);
    byKey.set(state.key, state);
    bySocket.set(raw, state);
    raw.once('close', () => release(state));
    if (secure) {
      pendingTls++;
      state.tlsTimer = timer(() => raw.destroy(), config.headerDeadlineMs);
    }
  });
  if (secure) {
    server.on('secureConnection', socket => {
      const state = byKey.get(socketKey(socket));
      if (!state || state.closed || closing) { socket.destroy(); return; }
      if (state.pendingTls) { state.pendingTls = false; pendingTls--; }
      untimer(state.tlsTimer);
      if (socket.alpnProtocol && socket.alpnProtocol !== 'http/1.1') { socket.destroy(); return; }
      admitSocket(socket, state);
    });
    server.on('tlsClientError', (_error, socket) => {
      // Malformed TLS is explicitly outside the zero-HTTP/no-FIN guarantee.
      socket.destroy(); emit('tls-error');
    });
  } else {
    server.on('connection', socket => {
      const state = bySocket.get(socket);
      if (state && !state.closed && !socket.destroyed) admitSocket(socket, state);
    });
  }

  function drive(state) {
    // No rejected async handler may escape EventEmitter into the host process.
    void runNext(state).catch(() => quarantine(state, 'handler-error'));
  }
  function finish(state) {
    if (state.closed || state.socket.destroyed || state.quarantined || closing) return;
    state.busy = false;
    if (state.queue.length) drive(state); else headerWait(state);
  }
  function enqueue(req, res, head, upgrade = false) {
    const state = bySocket.get(req.socket);
    req.on('error', noop);
    res?.on('error', noop);
    if (!state || state.closed || state.socket.destroyed || state.quarantined || closing) return;
    req.pause();
    state.socket.pause();
    clearHeader(state);
    if (!validRequest(req, upgrade)) {
      // Node 24 otherwise unconditionally destroys a parsed PRI method after
      // emitting request, even when a clientError handler owns rejection.
      if (req.method === 'PRI') req.method = 'REJECTED';
      quarantine(state, 'invalid-request');
      return;
    }
    if (state.queue.length >= config.maxQueuedRequests || (upgrade && (state.busy || state.queue.length))) {
      quarantine(state, 'pipeline-budget'); return;
    }
    state.queue.push({ req, res, head, upgrade });
    if (!state.busy) drive(state);
  }
  async function runNext(state) {
    if (state.closed || state.socket.destroyed || state.quarantined || closing || state.busy) return;
    const job = state.queue.shift();
    if (!job) { headerWait(state); return; }
    state.busy = true;
    if (authTokens.size >= config.maxPendingAuth) { quarantine(state, 'auth-budget'); return; }
    const token = {};
    authTokens.add(token);
    let timeout;
    let decision;
    const auth = Promise.resolve().then(() =>
      state.closed || state.socket.destroyed || state.quarantined || closing ? { kind: 'deny' } : options.authorize(job.req));
    // Slots are held until the *actual callback* settles, even after timeout,
    // so a stuck async authorizer cannot create unlimited abandoned promises.
    const settled = auth.then(value => { authTokens.delete(token); return value; }, () => {
      authTokens.delete(token); return { kind: 'deny' };
    });
    try {
      decision = await Promise.race([settled, new Promise(resolve => {
        timeout = timer(() => resolve({ kind: 'deny' }), config.headerDeadlineMs);
      })]);
    } finally { untimer(timeout); }
    if (state.closed || state.socket.destroyed || state.quarantined || closing) return;
    if (decision?.kind === 'bootstrap' && !job.upgrade && decision.status === 303 &&
        ['GET', 'HEAD'].includes(job.req.method) && job.req.url.split('?')[0] === '/') {
      try {
        const headers = checkedHeaders(decision.headers, { secureCookies: true });
        headers['content-length'] = '0';
        headers['cache-control'] = 'no-store';
        headers['referrer-policy'] = 'no-referrer';
        state.everAllowed = true;
        job.res.once('finish', () => finish(state));
        job.res.writeHead(303, headers);
        job.res.end();
        job.req.resume();
        state.socket.resume();
      } catch { quarantine(state, 'bootstrap-error'); }
      return;
    }
    if (decision?.kind !== 'allow') { quarantine(state, 'authorization-denied'); return; }
    state.everAllowed = true;
    let headers;
    try {
      if (loopbackDestination(options.getUpstream()).key !== destination.key) throw new Error('changed upstream');
      headers = checkedHeaders(await options.prepareUpstreamHeaders(job.req), { upgrade: job.upgrade });
    } catch { quarantine(state, 'upstream-policy-error'); return; }
    if (state.closed || state.socket.destroyed || state.quarantined || closing) return;
    try { proxy(state, job, headers); } catch { quarantine(state, 'proxy-error'); }
  }

  function proxy(state, job, headers) {
    const { req, res, upgrade, head } = job;
    let upstreamResponse;
    let upstreamSocket;
    let done = false;
    let connectTimer;
    const cancel = () => {
      if (done) return;
      done = true;
      untimer(connectTimer);
      req.unpipe();
      req.pause();
      upstreamResponse?.unpipe();
      upstreamSocket?.destroy();
      upstream.destroy();
      state.cancels.delete(cancel);
    };
    const fail = () => { if (!done && !state.closed && !closing) quarantine(state, 'proxy-error'); };
    let upstream;
    try { upstream = http.request({
      host: destination.host, port: destination.port, family: 4,
      method: req.method, path: req.url, headers, maxHeaderSize: config.maxHeaderBytes,
      insecureHTTPParser: false, highWaterMark: 16384,
      createConnection() {
        upstreamSocket = track(createConnection({ host: destination.host, port: destination.port,
          family: 4, allowHalfOpen: true, highWaterMark: 16384 }));
        upstreamSocket.setNoDelay(true);
        connectTimer = timer(fail, config.headerDeadlineMs);
        upstreamSocket.once('connect', () => untimer(connectTimer));
        return upstreamSocket;
      },
    }); } catch (error) {
      untimer(connectTimer);
      upstreamSocket?.destroy();
      throw error;
    }
    state.cancels.add(cancel);
    upstream.on('error', fail);
    upstream.on('continue', () => {
      if (!upgrade && !done && !state.quarantined && req.headers.expect?.toLowerCase() === '100-continue') {
        try { res.writeContinue(); } catch { fail(); }
      }
    });
    upstream.on('response', response => {
      upstreamResponse = response;
      response.on('error', fail);
      if (done || state.quarantined || state.closed) { response.destroy(); return; }
      if ([401, 403].includes(response.statusCode) || upgrade) { quarantine(state, 'upstream-rejection'); return; }
      try {
        const responseHeaders = checkedHeaders(response.headers, { response: true });
        res.once('finish', () => { cancel(); finish(state); });
        res.once('close', () => { if (!res.writableFinished && !done) fail(); });
        res.writeHead(response.statusCode, responseHeaders);
        response.pipe(res);
      } catch { fail(); }
    });
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      if (!upgrade || done || state.quarantined || state.closed || response.statusCode !== 101 ||
          response.headers.upgrade?.toLowerCase() !== 'websocket' ||
          !String(response.headers.connection || '').toLowerCase().split(/\s*,\s*/).includes('upgrade')) {
        socket.destroy(); quarantine(state, 'upstream-rejection'); return;
      }
      upstreamSocket = track(socket);
      socket.allowHalfOpen = true;
      socket.pause();
      let responseHead;
      try {
        const responseHeaders = checkedHeaders(response.headers, { upgrade: true, response: true });
        responseHead = 'HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(responseHeaders)
          .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`))
          .join('') + '\r\n';
      } catch { fail(); return; }
      state.upgraded = true;
      state.socket.write(responseHead);
      if (upstreamHead.length) state.socket.write(upstreamHead);
      if (head.length) socket.write(head);
      state.socket.pipe(socket);
      socket.pipe(state.socket);
      socket.once('end', () => { if (!state.socket.writableEnded) state.socket.end(); });
      socket.once('close', () => {
        if (!socket.readableEnded) state.socket.destroy();
        else if (!state.socket.writableEnded) state.socket.end();
        done = true;
        state.cancels.delete(cancel);
      });
      socket.on('error', fail);
      state.socket.resume();
      socket.resume();
      emit('upgrade');
    });
    if (upgrade) upstream.end();
    else { req.pipe(upstream); upstream.flushHeaders(); state.socket.resume(); }
  }

  server.on('request', (req, res) => enqueue(req, res));
  server.on('checkContinue', (req, res) => enqueue(req, res));
  server.on('checkExpectation', (req, res) => enqueue(req, res));
  server.on('upgrade', (req, _socket, head) => enqueue(req, undefined, head, true));
  server.on('connect', (req, socket) => {
    req.on('error', noop);
    quarantine(bySocket.get(socket), 'connect-denied');
  });
  server.on('clientError', (_error, socket) => {
    const state = bySocket.get(socket) || byKey.get(socketKey(socket));
    if (state && !state.pendingTls) quarantine(state, 'parse-error');
    else socket.destroy();
  });
  server.on('timeout', socket => quarantine(bySocket.get(socket), 'header-deadline'));
  server.on('error', () => {
    emit('listener-error');
    if (!closing) for (const socket of sockets) socket.destroy();
  });

  try {
    await new Promise((resolve, reject) => {
      const error = failure => reject(failure);
      server.once('error', error);
      server.listen({ host: options.host, port, exclusive: true }, () => {
        server.off('error', error);
        resolve();
      });
    });
  } catch (error) {
    closing = true;
    for (const handle of timers) clearTimeout(handle);
    for (const socket of sockets) socket.destroy();
    throw error;
  }

  return Object.freeze({
    origin: `${secure ? 'https' : 'http'}://${options.host}:${server.address().port}`,
    snapshot() {
      return Object.freeze({ closing, connections: states.size, sockets: sockets.size,
        quarantine: quarantined, quarantineIps: quarantinedByIp.size,
        pendingTls, pendingHeaders, pendingAuth: authTokens.size, timers: timers.size,
        upgrades: [...states].filter(state => state.upgraded).length });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
      authTokens.clear();
      const socketCloses = [...sockets].filter(socket => !socket.closed).map(socket =>
        new Promise(resolve => socket.once('close', resolve)));
      closePromise = new Promise(resolve => server.close(() => resolve()));
      for (const state of states) for (const cancel of state.cancels) cancel();
      for (const socket of sockets) socket.destroy();
      closePromise = Promise.all([closePromise, ...socketCloses]).then(() => undefined);
      return closePromise;
    },
  });
}
