import { isUnsupported, type HostPlugin } from '../ports/host/index.ts';
import { quietWorld } from './quiet-world.ts';

/**
 * The shipped host's plugin store, as a quiet world's run carries it: a spec of code that reads the plugin list, the
 * marketplace list or the cache asks here, never an adapter's own file. A host that keeps none fails the spec with its
 * reason.
 */
export function shippedPlugin(): HostPlugin {
  const { plugin } = quietWorld().host({ env: {}, platform: 'linux' });
  if (isUnsupported(plugin)) {
    throw new Error(`the shipped host keeps no plugin store: ${plugin.notice}`);
  }
  return plugin;
}
