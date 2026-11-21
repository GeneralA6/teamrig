import {
  isUnsupported,
  type HookBridge,
  type HostPaths,
  type HostPermissions,
  type HostPlugin,
  type HostPorts,
  type SessionIdentity,
  type SessionVariables,
  type StatusLine,
  type TranscriptReader,
  type UsageMeter,
} from '../ports/host/index.ts';
import type { ContextSource } from '../refresh/usage.ts';
import type { HostSecretFiles } from '../secret-guard/rules.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * The host ports of one run, built from the environment and platform that run sees: a command asks here, and words
 * a refusal for a port the host cannot fill.
 */
export function hostOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPorts {
  return runtime.host({ env: runtime.env, platform: runtime.platform });
}

/**
 * The hook bridge of one run, for a hook command. A host with no hooks calls none of them, so one run there is
 * refused with the host's own reason.
 */
export function hooksOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HookBridge {
  const { hooks } = hostOf(runtime);
  if (isUnsupported(hooks)) {
    throw new RefusedError(hooks.notice);
  }
  return hooks;
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

/**
 * Where the run's host keeps its files, or undefined on a host whose folders teamrig does not know: for a caller that
 * goes on without the host's own files, such as a hook that must never answer by a refusal.
 */
export function pathsIfKnown(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPaths | undefined {
  const { paths } = hostOf(runtime);
  return isUnsupported(paths) ? undefined : paths;
}

/**
 * Where the run's host keeps its files. A host whose folders teamrig does not know refuses with its own reason: for
 * a command whose whole work is in the host's own files, such as one that edits its settings.
 */
export function pathsOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPaths {
  const { paths } = hostOf(runtime);
  if (isUnsupported(paths)) {
    throw new RefusedError(paths.notice);
  }
  return paths;
}

/**
 * Who tells the secret guard the hosts' own secret files in this run: every host adapter teamrig ships with, then
 * the host the run works in, each glob once. A file is a secret for what it holds, whatever host runs the session,
 * and a machine may hold the files of a host other than the running one: so the running host adds to the shipped
 * hosts' files and takes none away. It never refuses, as the guard answers on every host: one that tells none of
 * its folders adds none.
 */
export function secretFilesOf(runtime: Pick<CliRuntime, 'host' | 'shippedHosts' | 'env' | 'platform'>): HostSecretFiles {
  const seen = { env: runtime.env, platform: runtime.platform };
  const named = [...runtime.shippedHosts, runtime.host].flatMap((source) => {
    const { paths } = source(seen);
    return isUnsupported(paths) ? [] : paths.secretFiles();
  });
  const once: readonly string[] = [...new Set(named)];
  return { secretFiles: () => once };
}

/** What a host telling nothing of its sessions tells a run: no part of who it is. */
const UNTOLD: SessionIdentity = { projectDir: undefined, startedAs: undefined, sessionKind: undefined, sessionId: undefined };

/**
 * Who the run's host says this run is: the folder its session started in, how the host was started, the kind of
 * session and the host's id of it. It never refuses: on a host that tells nothing of its sessions each part is
 * untold, and a caller goes on as in a run no session started, by the working folder and what its own input says.
 */
export function identityOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): SessionIdentity {
  const { launcher } = hostOf(runtime);
  return isUnsupported(launcher) ? UNTOLD : launcher.identity();
}

/**
 * The session variables teamrig holds in this run: those of every host adapter it ships with, then the running
 * host's, each name once. A machine may run a host other than the one this run works in, and a variable says who a
 * run is whatever host set it: so the running host adds to the shipped hosts' names and takes none away. It never
 * refuses: a host that tells nothing of its sessions adds none.
 */
export function sessionVariablesOf(runtime: Pick<CliRuntime, 'host' | 'shippedHosts' | 'env' | 'platform'>): SessionVariables {
  const seen = { env: runtime.env, platform: runtime.platform };
  const named = [...runtime.shippedHosts, runtime.host].flatMap((source) => {
    const { launcher } = source(seen);
    return isUnsupported(launcher) ? [] : [launcher.variables];
  });
  return {
    marks: [...new Set(named.flatMap((variables) => variables.marks))],
    identity: [...new Set(named.flatMap((variables) => variables.identity))],
  };
}

/** The host's own folder for the person of this run. A host whose folders teamrig does not know refuses, as `pathsOf` does. */
export function hostHomeOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform' | 'userHome'>): string {
  return pathsOf(runtime).home(runtime.userHome);
}

/** The host's own folder for the person of this run, or undefined on a host whose folders teamrig does not know. */
export function hostHomeIfKnown(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform' | 'userHome'>): string | undefined {
  return pathsIfKnown(runtime)?.home(runtime.userHome);
}

/** The run's permission rules. A host that keeps none refuses with its own reason, as `transcriptsOf` does. */
export function permissionsOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPermissions {
  const { permissions } = hostOf(runtime);
  if (isUnsupported(permissions)) {
    throw new RefusedError(permissions.notice);
  }
  return permissions;
}

/**
 * The run's permission rules, or undefined on a host that keeps none: for a check that goes on without them, such as
 * doctor's, which then has no rule to find missing.
 */
export function permissionsIfKept(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPermissions | undefined {
  const { permissions } = hostOf(runtime);
  return isUnsupported(permissions) ? undefined : permissions;
}

/** The run's plugin store. A host that keeps none refuses with its own reason, as `transcriptsOf` does. */
export function pluginOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPlugin {
  const { plugin } = hostOf(runtime);
  if (isUnsupported(plugin)) {
    throw new RefusedError(plugin.notice);
  }
  return plugin;
}

/**
 * The run's plugin store, or undefined on a host that keeps none: for a step that goes on without it, such as a
 * session's PATH, which then has no cache folder to leave out.
 */
export function pluginIfKept(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): HostPlugin | undefined {
  const { plugin } = hostOf(runtime);
  return isUnsupported(plugin) ? undefined : plugin;
}

/**
 * Whether a PATH folder is a plugin install's `bin` folder in the run's host's cache, for a session's PATH to leave
 * out. A host that keeps no plugin store has none, so every folder stays.
 */
export function cacheBinOf(runtime: Pick<CliRuntime, 'host' | 'env' | 'platform'>): (folder: string) => boolean {
  const plugin = pluginIfKept(runtime);
  return plugin === undefined ? () => false : (folder) => plugin.isCacheBin(folder);
}
