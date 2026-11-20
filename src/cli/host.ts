import type { HostPorts } from '../ports/host/index.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The host ports of one run, built from the environment and platform that run sees: a command asks here, and words
 * a refusal for a port the host cannot fill.
 */
export function hostOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPorts {
  return runtime.host({ env: runtime.env, platform: runtime.platform });
}
