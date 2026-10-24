import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { nextBatchText } from '../../decisions/batch.ts';
import { batchLines } from '../../decisions/lines.ts';
import { AskedStore } from '../../decisions/store.ts';
import { teamDecisions, type TeamDecisions } from '../../decisions/team.ts';
import { taskLabel } from '../../register/views.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Access, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { ownRegister } from './register.ts';

/**
 * `decisions` and `decisions asked`: the owner's decisions the lead asks in batches (src/decisions/batch.ts).
 * `decisions` prints the waits on the owner not yet asked and the asked ones past due, each as card facts, and
 * whether the batch is due now or when the next is; `decisions asked`, the lead's only, records that the lead asked
 * them, so the next batch holds the waits set since and the ones past due.
 */

interface DecisionsKit extends TeamDecisions {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  readonly lead: string;
  readonly now: number;
  /** The team's clock, which the batch times print on. */
  readonly zone: TimeZone;
}

/** The caller's team and its batch now, judged on the team's own register. */
async function decisionsKit(args: ParsedArgs, runtime: CliRuntime, access: Access): Promise<DecisionsKit> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, access);
  const roster = await rosterOf(runtime, kit, config);
  const lead = config.roles.lead;
  const { snapshot, elsewhere } = (await ownRegister(runtime)).own;
  const tasks = snapshot.state.tasks;
  const now = runtime.clock.now();
  const zone = teamZone(config, runtime);
  const decided = await teamDecisions(runtime.files, kit.paths, config, tasks, now, zone, elsewhere);
  return { kit, config, roster, lead, now, zone, ...decided };
}

/** `decisions`: the batch the lead asks the owner next, and whether it is due now. */
export async function decisions(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const dk = await decisionsKit(args, runtime, 'read');
  const lines = batchLines({ batch: dk.batch, ownerMarker: dk.config.register.ownerSource, command: KIT_NAME, lead: dk.lead, zone: dk.zone });
  lines.forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}

/** `decisions asked`: the lead records that it asked the owner the batch, the waits not yet asked and the ones past due. */
export async function decisionsAsked(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const dk = await decisionsKit(args, runtime, 'write');
  const caller = sessionIdOf(dk.roster, callerOf(args.flags, runtime.env));
  if (caller !== dk.lead) {
    throw new RefusedError(`only the lead (${dk.roster.nameOf(dk.lead) ?? dk.lead}) asks the owner's decisions`);
  }
  const ids = [...dk.batch.pending, ...dk.batch.overdue].map((wait) => taskLabel(wait.task, wait.team));
  if (ids.length === 0) {
    runtime.out.stdout(`ASKED nothing: no wait on ${dk.config.register.ownerSource} to ask; nothing recorded`);
    return EXIT.ok;
  }
  await new AskedStore(runtime.files, dk.kit.paths.decisionsAsked).write({ askedAt: new Date(dk.now).toISOString(), by: dk.lead, ids });
  runtime.out.stdout(`ASKED ${ids.length} decision(s) ${dk.zone.weekdayMinute(new Date(dk.now))}: ${ids.join(', ')}; ${nextBatchText(dk.batch, dk.zone)} holds the waits set since and the ones past due`);
  return EXIT.ok;
}
