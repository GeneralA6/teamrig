import { isUnsupported, type HostPermissions } from '../ports/host/index.ts';
import { quietWorld } from './quiet-world.ts';

/**
 * The shipped host's permission rules, as a quiet world's run carries them: a spec of code that reads or writes
 * permission rules asks here, never an adapter's own file. A host that keeps none fails the spec with its reason.
 */
export function shippedPermissions(): HostPermissions {
  const { permissions } = quietWorld().host({ env: {}, platform: 'linux' });
  if (isUnsupported(permissions)) {
    throw new Error(`the shipped host keeps no permission rule: ${permissions.notice}`);
  }
  return permissions;
}
