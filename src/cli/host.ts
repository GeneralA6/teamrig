import { isUnsupported, type HostPorts, type StatusLine, type TranscriptReader, type UsageMeter } from '../ports/host/index.ts';
import type { ContextSource } from '../refresh/usage.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * The host ports of one run, built from the environment and platform that run sees: a command asks here, and words
 * a refusal for a port the host cannot fill.
 */
export function hostOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPorts {
  return runtime.host({ env: runtime.env, platform: runtime.platform });
}

/**
 * The run's transcript reader, or undefined on a host that keeps no transcript teamrig can read: for a caller that
 * goes on without what a transcript would tell, such as a hook that must never answer by a refusal.
 */
export function transcriptsIfKept(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): TranscriptReader | undefined {
  const { transcripts } = hostOf(runtime);
  return isUnsupported(transcripts) ? undefined : transcripts;
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

/**
 * The run's usage meter, or undefined on a host whose calls teamrig cannot price: for a caller that goes on with the
 * cost unknown, such as a hook that must never answer by a refusal.
 */
export function usageIfMetered(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): UsageMeter | undefined {
  const { usage } = hostOf(runtime);
  return isUnsupported(usage) ? undefined : usage;
}

/**
 * What tells a session's context size on this run, or undefined on a host that keeps no readable transcript or prices
 * no call: a caller then goes on with the size unknown.
 */
export function contextSourceIfTold(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): ContextSource | undefined {
  const { transcripts, usage } = hostOf(runtime);
  return isUnsupported(transcripts) || isUnsupported(usage) ? undefined : { reader: transcripts, usage };
}

/** The run's status line. A host that draws none refuses with its own reason, as `transcriptsOf` does. */
export function statusLineOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): StatusLine {
  const { statusLine } = hostOf(runtime);
  if (isUnsupported(statusLine)) {
    throw new RefusedError(statusLine.notice);
  }
  return statusLine;
}

/** The run's usage meter. A host whose calls teamrig cannot price refuses with its own reason, as `transcriptsOf` does. */
export function usageOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): UsageMeter {
  const { usage } = hostOf(runtime);
  if (isUnsupported(usage)) {
    throw new RefusedError(usage.notice);
  }
  return usage;
}
