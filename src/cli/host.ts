import { isUnsupported, type HostPorts, type TranscriptReader } from '../ports/host/index.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * The host ports of one run, built from the environment and platform that run sees: a command asks here, and words
 * a refusal for a port the host cannot fill.
 */
export function hostOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPorts {
  return runtime.host({ env: runtime.env, platform: runtime.platform });
}

/**
 * The run's transcript reader. A host that keeps no transcript teamrig can read refuses with its own reason: a
 * command ends on it, and a hook, which lets no error out, does nothing.
 */
export function transcriptsOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): TranscriptReader {
  const { transcripts } = hostOf(runtime);
  if (isUnsupported(transcripts)) {
    throw new RefusedError(transcripts.notice);
  }
  return transcripts;
}
