import { loadHostPorts, type HostSource } from '../composition/host-ports.ts';
import type { JsonRecord } from '../core/guards.ts';
import { isUnsupported, type HookBridge, type HookEvent, type HookEventName, type HookReply, type ShellCall } from '../ports/host/index.ts';
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
