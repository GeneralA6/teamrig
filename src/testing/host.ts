import { loadHostPorts, type HostSource } from '../composition/host-ports.ts';
import type { JsonRecord } from '../core/guards.ts';
import { isUnsupported, type HookBridge, type HookEvent } from '../ports/host/index.ts';
import { hostDeps } from './adapter-deps.ts';

/**
 * The shipped host adapter, loaded once for every spec and given no program to run: a spec reads what the host
 * wrote through the code teamrig runs with, so a pin fails when that code changes.
 */
export const SHIPPED_HOST: HostSource = await loadHostPorts(hostDeps().run);

/** The shipped host's hook bridge on `platform`. */
export function testHooks(platform: NodeJS.Platform = 'linux'): HookBridge {
  const { hooks } = SHIPPED_HOST({ env: {}, platform });
  if (isUnsupported(hooks)) throw new Error(`the shipped host has no hook bridge: ${hooks.notice}`);
  return hooks;
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
