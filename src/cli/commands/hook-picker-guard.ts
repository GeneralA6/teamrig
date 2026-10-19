import type { KitConfig } from '../../config/types.ts';
import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { guardsPicker, pickerGuardOutput, pickerReason, refusesSession } from '../../hooks/picker-guard.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, rosterOf, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson, sessionTeam, teamSessionOf } from './hook-input.ts';

/**
 * The team session whose question picker the guard refuses (hooks/picker-guard.ts); undefined lets the call go. The
 * session is read only for a picker call with the switch on, so the tab-status hook's other events read no file.
 */
export async function refusedPickerSession(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: JsonRecord): Promise<string | undefined> {
  if (!guardsPicker(config.pickerGuard.enabled, payload)) {
    return undefined;
  }
  const session = await teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), sessionIdOf(payload));
  return refusesSession(session, config.roles.lead) ? session : undefined;
}

/** What the hook prints for this payload: the refusal with its reason, or '' when the picker opens. */
async function pickerGuardOutputOf(runtime: CliRuntime, payload: JsonRecord): Promise<string> {
  const found = await sessionTeam(payload, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit?.load.status !== 'loaded') {
    return '';
  }
  const session = await refusedPickerSession(runtime, kit, kit.load.config, payload);
  return session === undefined ? '' : pickerGuardOutput(pickerReason(KIT_NAME, session));
}

/**
 * PreToolUse on AskUserQuestion: with `pickerGuard.enabled`, refuses the question picker to every team session but
 * the lead, with a reason that says to record the decision on its task and go on with the next one. Outside a team,
 * with the guard off, for the lead, a tab that is no team session, input that is not a hook payload or on any error,
 * it prints nothing, so the picker opens.
 */
export async function pickerGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const output = isRecord(payload) ? await pickerGuardOutputOf(runtime, payload).catch(() => '') : '';
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}
