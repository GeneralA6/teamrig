import { isUnsupported, type UsageMeter } from '../ports/host/index.ts';
import { quietWorld } from './quiet-world.ts';

/**
 * The shipped host's usage meter, as a quiet world's run carries it: a spec of code that prices a call asks here,
 * never an adapter's own file. A host that prices no call fails the spec with its reason.
 */
export function shippedUsage(): UsageMeter {
  const { usage } = quietWorld().host({ env: {}, platform: 'linux' });
  if (isUnsupported(usage)) {
    throw new Error(`the shipped host prices no call: ${usage.notice}`);
  }
  return usage;
}
