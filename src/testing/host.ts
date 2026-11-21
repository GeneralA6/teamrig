import { loadHostPorts, type HostSource } from '../composition/host-ports.ts';
import type { JsonRecord } from '../core/guards.ts';
import {
  isUnsupported,
  unsupported,
  type HookBridge,
  type HookEvent,
  type HookEventName,
  type HookReply,
  type HostPaths,
  type SessionIdentity,
  type SessionVariables,
  type ShellCall,
} from '../ports/host/index.ts';
import { hostDeps } from './adapter-deps.ts';
import { bareHost } from './bare-host.ts';

/**
 * The shipped host adapter, loaded once for every spec and given no program to run: a spec reads what the host
 * wrote through the code teamrig runs with, so a pin fails when that code changes.
 */
export const SHIPPED_HOST: HostSource = await loadHostPorts(hostDeps().run);

/**
 * A bare host (`bareHost`) whose hooks still run: the shipped host's hook bridge and tool calls, and no other port.
 * For a spec of what a hook does on a host lacking the rest, such as a transcript or a usage meter: on a wholly
 * bare host the hook would read no input at all.
 */
export const HOOKS_ONLY_HOST: HostSource = (given) => {
  const { hooks, toolCall } = SHIPPED_HOST(given);
  return { ...bareHost(), hooks, toolCall };
};

/**
 * The shipped host, telling none of its folders: every other port is the shipped one. For a spec of what a run does
 * with no place of the host known, while its hooks, transcript and usage are still read.
 */
export const NO_PATHS_HOST: HostSource = (given) => ({ ...SHIPPED_HOST(given), paths: unsupported('no folder of the host is known') });

/**
 * The shipped host, telling nothing of its sessions: every other port is the shipped one. For a spec of what a run
 * does when its host names no folder a session started in, whatever the environment holds.
 */
export const NO_SESSION_HOST: HostSource = (given) => ({ ...SHIPPED_HOST(given), launcher: unsupported('no session of the host is told') });

/**
 * The shipped host, saying every run is `identity` whatever the environment holds: for a spec of a reader that must
 * ask the host who the run is and read no variable of a host itself.
 */
export function hostTelling(identity: Partial<SessionIdentity>): HostSource {
  const told: SessionIdentity = { projectDir: undefined, startedAs: undefined, sessionKind: undefined, sessionId: undefined, ...identity };
  return (given) => ({ ...SHIPPED_HOST(given), launcher: { variables: testSessionVariables(), identity: () => told } });
}

/** The session variables the shipped host hands a run: the ones its declaration names. */
export function testSessionVariables(): SessionVariables {
  const { launcher } = SHIPPED_HOST({ env: {}, platform: 'linux' });
  if (isUnsupported(launcher)) throw new Error(`the shipped host tells nothing of its sessions: ${launcher.notice}`);
  return launcher.variables;
}

/** The shipped host's paths in the environment `env` on `platform`: where a spec's files are, as a run would be told them. */
export function testPaths(env: Readonly<Record<string, string | undefined>> = {}, platform: NodeJS.Platform = 'linux'): HostPaths {
  const { paths } = SHIPPED_HOST({ env, platform });
  if (isUnsupported(paths)) throw new Error(`the shipped host tells none of its folders: ${paths.notice}`);
  return paths;
}

/** The shipped host's hook bridge on `platform`. */
export function testHooks(platform: NodeJS.Platform = 'linux'): HookBridge {
  const { hooks } = SHIPPED_HOST({ env: {}, platform });
  if (isUnsupported(hooks)) throw new Error(`the shipped host has no hook bridge: ${hooks.notice}`);
  return hooks;
}

/** What the shipped host reads for a hook's `reply` to the event `on`: '' when the hook has nothing to say. */
export function replyText(on: HookEventName, reply: HookReply | undefined, platform: NodeJS.Platform = 'linux'): string {
  return reply === undefined ? '' : testHooks(platform).reply(on, reply);
}

/**
 * The event the shipped host's bridge reads out of `payload`, a hook input as the host sends it: a spec keeps its
 * payload and hands the code under test what a run would.
 */
export function hookEventOf(payload: JsonRecord, platform: NodeJS.Platform = 'linux'): HookEvent {
  const event = testHooks(platform).parse(JSON.stringify(payload));
  if (event === undefined) throw new Error('the hook bridge read no event out of the payload');
  return event;
}

/**
 * The shell call the shipped host reads when its tool `tool` runs `line` on `platform`: a spec's way to the texts the
 * shell may run, as a hook is handed them.
 */
export function shellCallOf(tool: string, line: string, platform: NodeJS.Platform = 'linux'): ShellCall {
  const { call } = hookEventOf({ tool_name: tool, tool_input: { command: line } }, platform);
  if (call?.kind !== 'shell') throw new Error(`the shipped host reads no shell call for the tool ${tool}`);
  return call;
}
