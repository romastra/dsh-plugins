import Schema from '@deepseek-ai/schemastery';
import { localPath, pinnedPeer, RigError } from './rig-transport.mjs';

const absolutePath = label => Schema.string().required().description(label);
const sha256 = () => Schema.string().required().pattern(/^[a-f0-9]{64}$/);
const peer = Schema.object({
  ip: Schema.string().required().description('Tailscale IPv4 of the verified ASR host'),
  port: Schema.number().step(1).min(1).max(65535).default(8081).description('TCP port of the ASR service'),
  peer_id: Schema.string().pattern(/^[A-Za-z0-9_-]{1,128}$/),
  public_key: Schema.string().pattern(/^nodekey:[a-f0-9]{64}$/),
  // Preserve the earlier id/publicKey/origin spelling for existing private profiles.
  id: Schema.string().pattern(/^[A-Za-z0-9_-]{1,128}$/),
  publicKey: Schema.string().pattern(/^nodekey:[a-f0-9]{64}$/),
  origin: Schema.string().description('Optional exact http://<Tailnet IPv4>:<port> consistency check'),
}).required();
const rig = Schema.object({
  secretFile: absolutePath('Owner-only local file containing the server token, not the token itself'),
  secretFormat: Schema.union(['raw', 'polaris-env']).default('raw'),
  tailscalePath: absolutePath('Verified local Tailscale executable'),
  tailscaleSha256: sha256(),
  ffmpegPath: absolutePath('Verified local FFmpeg executable'),
  ffmpegSha256: sha256(),
  peer,
}).required();
export const Config = Schema.object({
  rig,
  enableLocalRollback: Schema.boolean().default(false),
  local: Schema.object({
    workerRoot: Schema.string(),
    threads: Schema.const(6),
    maxRecordingSeconds: Schema.const(120),
    maxAudioBytes: Schema.number().step(1).min(512).max(20 * 1024 * 1024),
  }),
});

export function resolveConfig(input) {
  const config = Config(input);
  if (!config?.rig?.peer) throw new RigError(503, 'rig_configuration_required');
  const { rig } = config;
  for (const field of ['secretFile', 'tailscalePath', 'ffmpegPath']) localPath(rig[field]);
  return { ...config, rig: { ...rig, peer: pinnedPeer(rig.peer) } };
}
