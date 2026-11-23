import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Config, resolveConfig } from '../packages/voice-ext-inference/config.mjs';
import { createRigTransport, verifyPeerMap } from '../packages/voice-ext-inference/rig-transport.mjs';

const pin = { ip: '100.64.200.201', port: 18443, peer_id: 'testPeer', public_key: `nodekey:${'1'.repeat(64)}` };
const map = { BackendState: 'Running', Peer: { fixture: {
  ID: pin.peer_id, PublicKey: pin.public_key, TailscaleIPs: [pin.ip], Online: true,
} } };
const fixture = peer => ({ rig: {
  peer, secretFile: 'C:/example/asr-token.txt', tailscalePath: 'C:/example/tailscale.exe',
  ffmpegPath: 'C:/example/ffmpeg.exe', tailscaleSha256: '1'.repeat(64), ffmpegSha256: '2'.repeat(64),
} });

function mockRequest(expected, actual, activity) {
  return (options, receive) => {
    assert.equal(options.protocol, 'http:');
    assert.equal(options.hostname, expected.ip);
    assert.equal(options.port, expected.port);
    assert.equal(options.path, '/asr/status');
    const req = new EventEmitter();
    const socket = new EventEmitter();
    socket.connecting = true;
    req.destroy = () => { activity.destroyed++; };
    req.end = () => {
      assert.equal(socket.connecting, false, 'Do not send any bytes before checking the peer socket');
      activity.sent++;
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      receive(res);
      res.emit('data', Buffer.from('{"ready":true}'));
      res.emit('end');
    };
    queueMicrotask(() => {
      req.emit('socket', socket);
      assert.equal(activity.sent, 0);
      socket.remoteAddress = `::ffff:${actual.ip}`;
      socket.remotePort = actual.port;
      socket.connecting = false;
      socket.emit('connect');
    });
    return req;
  };
}

test('DSH Config preserves a custom Tailnet address and port, with 8081 as a default', () => {
  assert.equal(Config(fixture(pin)).rig.peer.port, 18443);
  assert.deepEqual(resolveConfig(fixture(pin)).rig.peer, { ip: pin.ip, port: 18443, id: pin.peer_id, publicKey: pin.public_key });
  assert.equal(resolveConfig(fixture({ ...pin, port: undefined })).rig.peer.port, 8081);
  for (const bad of [undefined, { ...pin, port: 0 }, { ...pin, port: 65536 }, { ...pin, port: 123.5 }, { ...pin, ip: '127.0.0.1' }, { ...pin, origin: `http://${pin.ip}:8081` }]) {
    assert.throws(() => resolveConfig(fixture(bad)));
  }
});

test('a configured ASR endpoint completes a request after proof and socket admission', async () => {
  const activity = { sent: 0, destroyed: 0 };
  const rig = createRigTransport(resolveConfig(fixture(pin)).rig, {
    peerMap: async () => map,
    secret: async () => 'test-only-value',
    request: mockRequest(pin, pin, activity),
  });
  assert.deepEqual(await rig.status(), { ready: true });
  assert.deepEqual(activity, { sent: 1, destroyed: 0 });
});

test('an unmatched Tailnet identity stops before credentials and HTTP', async () => {
  assert.equal(verifyPeerMap(map, pin), true);
  let reads = 0;
  const rig = createRigTransport(fixture({ ...pin, peer_id: 'wrong' }).rig, {
    peerMap: async () => map,
    secret: async () => { reads++; },
    request: () => assert.fail('unexpected request'),
  });
  await assert.rejects(rig.status(), /peer_identity_mismatch/);
  assert.equal(reads, 0);
});

test('a wrong connected IP or port stops before transmission', async () => {
  for (const actual of [{ ...pin, port: 1 }, { ...pin, ip: '100.64.200.202' }]) {
    const activity = { sent: 0, destroyed: 0 };
    const rig = createRigTransport(fixture(pin).rig, {
      peerMap: async () => map,
      secret: async () => 'test-only-value',
      request: mockRequest(pin, actual, activity),
    });
    await assert.rejects(rig.status(), /connected_peer_mismatch/);
    assert.deepEqual(activity, { sent: 0, destroyed: 1 });
  }
});
