import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { formatAddress, type SessionAddress } from '../../core/address.ts';
import { KIT_NAME } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { nextBatchText, waitsOfTeams, type DecisionBatch } from '../../decisions/batch.ts';
import { batchLines } from '../../decisions/lines.ts';
import { AskedStore } from '../../decisions/store.ts';
import { taskLabel } from '../../register/views.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { readRunFiles } from '../hand-step-file.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Access, type Kit } from '../kit.ts';
import { ownerBatchOf } from '../owner-batch.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { ownRegister } from './register.ts';

/**
 * `decisions` and `decisions asked`: the owner's decisions the lead asks in batches (src/decisions/batch.ts).
 * `decisions` prints the waits on the owner not yet asked and the asked ones past due, each as card facts, and
 * whether the batch is due now or when the next is; `decisions asked`, the lead's only, records that the lead asked
 * them, so the next batch holds the waits set since and the ones past due. A root team's batch holds the waits of
 * every team under it too; a child team's go up to the lead at its tree's root, who asks them (T1018), so in a child
 * team `decisions` prints its own and its teams' waits of that batch and `decisions asked` is refused.
 */

interface DecisionsKit {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  readonly lead: string;
  readonly now: number;
  /** The team's clock, which the batch times print on. */
  readonly zone: TimeZone;
  readonly batch: DecisionBatch;
  /** For a child team, the lead at its tree's root who asks the owner its waits; undefined in a root team. */
  readonly askedBy: SessionAddress | undefined;
}

/** The caller's team and the batch that holds its waits now: in a child team, only its own and its teams' waits of it. */
async function decisionsKit(args: ParsedArgs, runtime: CliRuntime, access: Access): Promise<DecisionsKit> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, access);
  const roster = await rosterOf(runtime, kit, config);
  const lead = config.roles.lead;
  const { snapshot, elsewhere, ranking } = (await ownRegister(runtime)).own;
  const now = runtime.clock.now();
  const zone = teamZone(config, runtime);
  const team = kit.paths.team;
  const loaded = await loadTree(runtime);
  const { batch, askedBy } = await ownerBatchOf(runtime, { team, config, paths: kit.paths, tasks: snapshot.state.tasks, elsewhere, ranking }, loaded, now);
  const held = askedBy === undefined ? batch : waitsOfTeams(batch, [team, ...loaded.tree.descendantsOf(team)]);
  return { kit, config, roster, lead, now, zone, batch: held, askedBy };
}

/** `decisions`: the batch the lead asks the owner next, and whether it is due now. */
export async function decisions(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const dk = await decisionsKit(args, runtime, 'read');
  const askedBy = dk.askedBy === undefined ? undefined : formatAddress(dk.askedBy);
  const runFiles = await readRunFiles(
    runtime,
    [...dk.batch.pending, ...dk.batch.overdue].map((wait) => wait.task),
  );
  const lines = batchLines({ batch: dk.batch, ownerMarker: dk.config.register.ownerSource, command: KIT_NAME, lead: dk.lead, askedBy, zone: dk.zone, runFiles });
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
  if (dk.askedBy !== undefined) {
    const team = dk.kit.paths.team;
    throw new RefusedError(`team ${team} asks no owner: ${formatAddress(dk.askedBy)} asks the owner ${team}'s waits, in its batches`);
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
