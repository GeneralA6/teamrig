import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { toJsonlLine } from '../../core/jsonl.ts';
import { passRecordGuardOutput } from '../../hooks/pass-record-guard.ts';
import { guardsPassed, preToolUseRouteOf, routeAllowOn, routeAllowOutput, routeAllowRecord } from '../../hooks/route-allow.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import type { CommandTable } from '../../slash/plan.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { hookLogOf } from '../hook-logs.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { guardLoadOf, type GuardLoad } from './hook-guard-load.ts';
import { dbWriteGuardOutputOf, execGuardOutputOf, packageGuardOutputOf, pushGuardOutputOf, secretGuardOutputOf, serviceRoleGuardOutputOf } from './hook-guard-outputs.ts';
import { envSession, parseJson } from './hook-input.ts';
import { roleAllowOutputOf } from './hook-role-allow.ts';
import { callRouteOf } from './hook-route-context.ts';

/**
 * What `hook route-allow` takes from the CLI: its command table, which reads a route's line, given so this module never
 * imports run.ts back.
 */
export interface RouteAllowDeps {
  readonly table: CommandTable;
}

/** True when every teamrig guard passed the call, with the same config load its own hook reads (Q7.1). */
async function everyGuardPassed(runtime: CliRuntime, guard: GuardLoad, payload: JsonRecord): Promise<boolean> {
  const answers = await Promise.all([
    pushGuardOutputOf(runtime, guard, payload),
    packageGuardOutputOf(runtime, guard, payload),
    execGuardOutputOf(runtime, guard, payload),
    dbWriteGuardOutputOf(runtime, guard, payload),
    serviceRoleGuardOutputOf(runtime, guard, payload),
  ]);
  return guardsPassed([...answers, secretGuardOutputOf(runtime, guard, payload), passRecordGuardOutput(payload)]);
}

/**
 * What the hook prints for this payload: an allow for a line that runs a route marked for PreToolUse, or for a service
 * role's call (hook-role-allow.ts), once every teamrig guard passed the same call; else ''. Each allow is logged by its
 * route or its role.
 */
async function routeAllowOutputOf(runtime: CliRuntime, payload: JsonRecord, deps: RouteAllowDeps): Promise<string> {
  const guard = await guardLoadOf(payload, runtime);
  const kit = guard?.kit;
  if (guard === undefined || kit === undefined || kit.load.status !== 'loaded') {
    return '';
  }
  const passed = (): Promise<boolean> => everyGuardPassed(runtime, guard, payload);
  if (!routeAllowOn(kit.load.config.prompts)) {
    return roleAllowOutputOf(runtime, kit, payload, deps.table, passed);
  }
  const route = preToolUseRouteOf(await callRouteOf(runtime, kit, kit.load.config, payload, deps.table));
  if (route === undefined) {
    return roleAllowOutputOf(runtime, kit, payload, deps.table, passed);
  }
  if (!(await passed())) {
    return '';
  }
  const record = routeAllowRecord({ at: new Date(runtime.clock.now()), session: envSession(runtime), claudeSession: sessionIdOf(payload), route: route.id });
  // Best effort, like the prompt answers: a full disk or a held lock must not take the allow away.
  await hookLogOf(runtime, kit.paths, 'prompt-answers').append(toJsonlLine(record)).catch(() => undefined);
  return routeAllowOutput(route);
}

/**
 * PreToolUse on Bash: under `prompts.hookAsks: refuse` with `prompts.routeAllow` on (its default), lets a line that runs
 * a sanctioned route marked for it (permissions/sanctioned.ts: merge, deploy, exec request, worktree remove, git commit)
 * run with no permission check, once the push, package, secret, exec, db-write and pass-record guards all passed it; logs each
 * allow to `state/prompt-answers.jsonl` by its route, never its command. With the switch on, whatever asks say, it also
 * lets a service role's call run for the tab bound to a holder of the role, up to the role's daily cap, then asks
 * (T2984, hook-role-allow.ts). Outside a team, with the switch off or the config missing or broken, for any other line
 * or tool, when a guard asks or refuses, for input that is not a hook payload or on any error, it prints nothing, so
 * the guards and Claude Code's own permission check decide: it fails closed.
 */
export function routeAllow(deps: RouteAllowDeps): (args: ParsedArgs, runtime: CliRuntime) => Promise<ExitCode> {
  return async (args, runtime) => {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const output = isRecord(payload) ? await routeAllowOutputOf(runtime, payload, deps).catch(() => '') : '';
    if (output !== '') {
      runtime.out.stdout(output);
    }
    return EXIT.ok;
  };
}
