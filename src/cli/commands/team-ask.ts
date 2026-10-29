import type { KitConfig } from '../../config/types.ts';
import type { TeamTree } from '../../config/tree.ts';
import { formatAddress, type SessionAddress } from '../../core/address.ts';
import type { AddInput, Verdict } from '../../register/policy.ts';
import type { WriteResult } from '../../register/register.ts';
import { askedNotice } from '../../register/views.ts';
import { openKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { RefusedError, type CliRuntime } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { teamOf, tellAssigned, tellLine, type Team } from './register-team.ts';

/** The caller of a write into another team's register: its address, its own team's config, the team tree and the written team's lead. */
export interface TreeCaller {
  readonly from: SessionAddress;
  readonly config: KitConfig;
  readonly tree: TeamTree;
  readonly targetLead: string;
}

/** The caller, a session of team `team`, as `<team>/<id>` and the team tree it writes across; refused when team `target` has no config here. */
export async function treeCallerOf(runtime: CliRuntime, team: string, caller: string, target: string): Promise<TreeCaller> {
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const from = { team, id: sessionIdOf(await rosterOf(runtime, kit, config), caller) };
  const { tree } = await loadTree(runtime);
  const targetLead = tree.leadOf(target);
  if (targetLead === undefined) {
    throw new RefusedError(`no team ${target} with a config in this kit home`);
  }
  return { from, config, tree, targetLead };
}

/** Another team asked for work: its id, and the task's owner there, a session by name or id; undefined is that team's lead. */
export interface TeamAsk {
  readonly asked: string;
  readonly owner: string | undefined;
}

/** The asked team's verdict on the task, and that team, whose zone and paths the task is shown in. */
export interface AskedTask {
  readonly verdict: Verdict<WriteResult>;
  readonly target: Team;
}

/**
 * A session asks another team of its tree for work (T1141). The task lands in that team's register only, as an event
 * by the asker's `<team>/<id>`, which is also its source, owned by `ask.owner`, else by that team's lead. The owner
 * gets an inbox line from the asker's address, and the team's lead, when it is not the owner, a copy line, as it sets
 * its team's work order and may reorder or reassign it. A team outside the caller's tree, or an owner not on its
 * roster, is refused; a refused write tells no one.
 */
export async function askTeam(runtime: CliRuntime, caller: TreeCaller, ask: TeamAsk, input: Omit<AddInput, 'owner' | 'source'>): Promise<AskedTask> {
  const { asked } = ask;
  const from = formatAddress(caller.from);
  if (!caller.tree.sameTree(caller.from.team, asked)) {
    throw new RefusedError(`team ${asked} is not in ${caller.from.team}'s team tree, so ${from} may not add its tasks`);
  }
  const target = await teamOf(runtime, await openKit(runtime, asked), 'write');
  const lead = caller.targetLead;
  const found = ask.owner === undefined ? { ok: true as const, id: lead } : target.roster.lookup(ask.owner);
  if (!found.ok) {
    throw new RefusedError(`team ${asked}: ${found.error}`);
  }
  const verdict = await target.register.addFromTeam(from, { ...input, owner: found.id, source: from });
  if (verdict.ok) {
    const { task } = verdict.value;
    await tellAssigned(runtime, target, from, task, formatAddress({ team: asked, id: task.owner }));
    if (task.owner !== lead) {
      const shown = formatAddress({ team: asked, id: lead });
      await tellLine(runtime, target, from, lead, askedNotice(task, target.zone), `${shown} was not told of ${task.id}`, shown);
    }
  }
  return { verdict, target };
}
