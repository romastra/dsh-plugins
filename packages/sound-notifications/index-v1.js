// New module generation for in-process upgrade from 1.0.0. Config and the
// existing profile namespace stay unchanged; the runtime owns route cleanup.
export { Config, inject } from './index.js';
import { installHost } from './host-runtime.js?rev=1.0.1';
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  return installHost(ctx, config);
}
