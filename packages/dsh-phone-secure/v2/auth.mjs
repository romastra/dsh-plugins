import { isIPv4 } from 'node:net';
import { isBindableIpv4 } from './net-policy.mjs';

const DENY = Object.freeze({ kind: 'deny' });
const ALLOW = Object.freeze({ kind: 'allow' });

function captureResponse() {
  let status;
  let headers = {};
  return {
    writeHead(code, values = {}) {
      status = code;
      headers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
    },
    end() {},
    result() { return { status, headers }; },
  };
}

function asCookies(value) {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length || list.some(item => typeof item !== 'string' || /[\r\n]/.test(item))) {
    throw new Error('Invalid native authentication result');
  }
  return list;
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !isIPv4(url.hostname) || !url.hostname.startsWith('127.') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('A fixed plain-HTTP IPv4 loopback origin is required');
  }
  return url;
}

function headerCount(req, name) {
  if (!Array.isArray(req.rawHeaders)) return 0;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() === name) count++;
  }
  return count;
}

/** Explicit outer trust boundary. BrowserAuth.authorizeIndex does not perform it. */
export function isTrustedPublicRequest(req, publicOrigin) {
  try {
    const expected = new URL(publicOrigin);
    if (expected.protocol !== 'https:' || !isBindableIpv4(expected.hostname)) return false;
    if (headerCount(req, 'host') !== 1 || typeof req.headers?.host !== 'string' ||
        req.headers.host.toLowerCase() !== expected.host.toLowerCase()) return false;
    if (headerCount(req, 'origin') > 1 || headerCount(req, 'cookie') > 1) return false;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (typeof origin !== 'string' || origin !== expected.origin || new URL(origin).origin !== origin) return false;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (typeof req.url !== 'string' || req.url.length > 8192 || !req.url.startsWith('/') ||
        req.url.startsWith('//') || /[\r\n#]/.test(req.url)) return false;
    const url = new URL(req.url, expected);
    if (url.origin !== expected.origin || url.searchParams.getAll('token').length > 1) return false;
    return true;
  } catch { return false; }
}

/**
 * Native DSH owner-browser authorization, with no copied signing key and no
 * independent cookie verifier. Public credentials retain their actual LAN
 * authority. The private forwarding cookie is minted by the same native DSH
 * authorizer for the existing loopback carrier and is never returned to clients.
 * This makes roaming independent of the core's trustedHosts configuration.
 */
export function createDshAuthorizer({ connection, publicOrigin, getUpstream, isActive = () => true }) {
  const publicUrl = new URL(publicOrigin);
  if (publicUrl.protocol !== 'https:' || !isBindableIpv4(publicUrl.hostname)) {
    throw new Error('An explicit HTTPS adapter IPv4 origin is required');
  }
  let dead = false;
  let innerCookie = '';
  let innerOrigin = '';

  function active() { return !dead && isActive(); }
  function probeHeaders(origin, cookie) {
    return { host: origin.host, origin: origin.origin, cookie, 'sec-fetch-site': 'same-origin' };
  }
  function obtainInnerCookie(origin) {
    const launch = new URL(connection.authenticatedUrl(origin.origin + '/'));
    const sink = captureResponse();
    connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host: origin.host } }, sink);
    const result = sink.result();
    if (result.status !== 303 || result.headers.location !== './') throw new Error('Native authentication is unavailable');
    const cookie = asCookies(result.headers['set-cookie']).map(item => item.split(';', 1)[0]).join('; ');
    if (connection.requestRejection({ headers: probeHeaders(origin, cookie) }) !== undefined) {
      throw new Error('Native authentication is unavailable');
    }
    innerCookie = cookie;
    innerOrigin = origin.origin;
  }
  function nativeReady() {
    if (!active()) return false;
    const origin = loopbackOrigin(getUpstream());
    if (innerOrigin !== origin.origin || !innerCookie) obtainInnerCookie(origin);
    let rejection = connection.requestRejection({ headers: probeHeaders(origin, innerCookie) });
    if (rejection === 401) {
      // Refresh an expired private cookie, but a disposed Connection still fails
      // the subsequent native admission check and is never bypassed.
      obtainInnerCookie(origin);
      rejection = connection.requestRejection({ headers: probeHeaders(origin, innerCookie) });
    }
    return rejection === undefined && active();
  }

  function authorize(req) {
    try {
      if (!active() || !isTrustedPublicRequest(req, publicUrl.origin) || !nativeReady()) return DENY;
      const sink = captureResponse();
      const mayServe = connection.authorizeIndex(req, sink);
      if (!active()) return DENY;
      if (mayServe === true) return ALLOW;
      const { status, headers } = sink.result();
      const url = new URL(req.url, publicUrl);
      if (status === 303 && req.method === 'GET' && url.pathname === '/' &&
          url.searchParams.getAll('token').length === 1 && headers.location === './') {
        // Only the exact native login response may bootstrap. Do not infer
        // authentication from an arbitrary proxied 303 elsewhere in the app.
        const safe = { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
        if (headers['set-cookie'] !== undefined) safe['set-cookie'] = asCookies(headers['set-cookie']);
        return { kind: 'bootstrap', status: 303, headers: safe };
      }
      return DENY;
    } catch { return DENY; }
  }
  return {
    authorize,
    prepareUpstreamHeaders(req) {
      // Defense in depth: even a future caller omitting the first gate cannot
      // obtain the private owner cookie for an unauthenticated request.
      if (authorize(req).kind !== 'allow') {
        throw new Error('The authenticated carrier is unavailable');
      }
      const target = loopbackOrigin(getUpstream());
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const name = key.toLowerCase();
        if (name === 'cookie' || name === 'host' || name === 'origin' || name === 'referer' ||
            name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'proxy-authorization' ||
            name === 'proxy-connection') continue;
        headers[name] = value;
      }
      headers.host = target.host;
      headers.cookie = innerCookie;
      if (req.headers.origin !== undefined) headers.origin = target.origin;
      return headers;
    },
    destroy() { dead = true; innerCookie = ''; innerOrigin = ''; },
  };
}
