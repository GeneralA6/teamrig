import type { KitConfig } from '../../config/types.ts';
import { recordField, stringField, type JsonRecord } from '../../core/guards.ts';
import { toJsonlLine } from '../../core/jsonl.ts';
import { ROLE_CAP_WINDOW_MS, roleAllowOutput, roleAllowRecord, roleAllowsSince, roleCapOutput, roleHolding } from '../../hooks/service-role-allow.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { toolRoleCallOf } from '../../permissions/service-role-call.ts';
import type { CommandTable } from '../../slash/plan.ts';
import { hookLogOf } from '../hook-logs.ts';
import { rosterOf, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { tabSessionOf } from '../tab-session.ts';
import { kitContextOf } from './hook-route-context.ts';

/**
 * The session the tab holds roles as (T2984, condition C1): the one area its every inbox mark names, on the roster, and
 * the same session the call names with its `--session`, which every role call carries, so a flag never lends a tab
 * another session's role; undefined otherwise.
 */
async function holderOf(runtime: CliRuntime, kit: Kit, config: KitConfig, claudeSession: string, caller: string): Promise<string | undefined> {
  const roster = await rosterOf(runtime, kit, config);
  return tabSessionOf(runtime.files, kit.paths.inboxMarks, roster, claudeSession, caller);
}

/**
 * What the route-allow hook prints for a service role's call: an allow when the tab's holder holds a role giving the
 * call's command, every guard passed it (`guardsPass`) and the role is under its daily cap; an ask of the owner past
 * the cap; else '', so the permission check decides. It answers only with the switch on and a config that loaded with
 * no issue from this release (a newer one's or a broken key's config gives no role), and only once the allow is
 * logged: the cap counts the log, so a log it cannot write lets nothing past.
 */
export async function roleAllowOutputOf(runtime: CliRuntime, kit: Kit, payload: JsonRecord, cli: CommandTable, guardsPass: () => Promise<boolean>): Promise<string> {
  const { load } = kit;
  if (load.status !== 'loaded' || load.issues.length > 0 || load.newerVersion !== undefined || load.config.prompts.routeAllow !== 'on') {
    return '';
  }
  const { config } = load;
  const claudeSession = sessionIdOf(payload);
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (claudeSession === null || command === undefined) {
    return '';
  }
  const context = { ...kitContextOf(runtime, payload, cli), repos: config.github.repos };
  const call = await toolRoleCallOf(stringField(payload, 'tool_name'), command, runtime.platform, context);
  const holder = call === undefined ? undefined : await holderOf(runtime, kit, config, claudeSession, call.session);
  const role = call === undefined || holder === undefined ? undefined : roleHolding(config.serviceRoles, call.command, holder);
  if (call === undefined || holder === undefined || role === undefined || !(await guardsPass())) {
    return '';
  }
  const log = hookLogOf(runtime, kit.paths, 'prompt-answers');
  const now = runtime.clock.now();
  const cap = config.prompts.serviceRoleDailyCap;
  if (roleAllowsSince((await log.read()) ?? '', role, now - ROLE_CAP_WINDOW_MS) >= cap) {
    return roleCapOutput(role, cap, config.prompts.hookAsks);
  }
  await log.append(toJsonlLine(roleAllowRecord({ at: new Date(now), session: holder, claudeSession, role, call })));
  return roleAllowOutput(role, call);
}
