import type { Checked } from '../setup/team-create.ts';
import { LeadTree } from './lead-tree.ts';
import type { KitConfig } from './types.ts';

/**
 * Edits of the team's `leads` (T781), pure: each takes the parsed config and returns the next `leads`, or why not, so
 * `promote`, `demote` and `retire` can preview before they write. Every edit keeps the tree whole: a session stays
 * listed under at most one sub-lead, and a group never ends up under itself.
 */

export type Leads = KitConfig['leads'];
type TreeConfig = Pick<KitConfig, 'sessions' | 'roles' | 'leads'>;

/** `leads` with `subLead`'s list replaced, dropped when empty, every other entry in place. */
function withList(leads: Leads, subLead: string, members: readonly string[]): Leads {
  const next = Object.fromEntries(Object.entries(leads).filter(([id]) => id !== subLead));
  return members.length === 0 ? next : { ...next, [subLead]: members };
}

/** The refusal for a member list, or undefined: at least one, each once, none the sub-lead itself. */
function membersProblem(subLead: string, members: readonly string[]): string | undefined {
  if (members.length === 0) {
    return `--members names no session for ${subLead} to lead`;
  }
  const twice = members.find((member, index) => members.indexOf(member) !== index);
  if (twice !== undefined) {
    return `--members names ${twice} twice`;
  }
  return members.includes(subLead) ? `${subLead} cannot lead itself` : undefined;
}

/**
 * `caller` makes `subLead`, one of its direct members, the leader of `members`, other direct members of its own: they
 * leave the caller's list (the lead lists no one, so its members are simply unlisted) and join the sub-lead's, which
 * keeps the members it already had. A member that leads others brings its group along.
 */
export function promoted(config: TreeConfig, caller: string, subLead: string, members: readonly string[]): Checked<Leads> {
  const tree = new LeadTree(config);
  if (!tree.isLeader(caller)) {
    return { ok: false, problem: `${caller} leads no one: only the lead or a sub-lead promotes` };
  }
  const notMine = [subLead, ...members].find((id) => tree.leaderOf(id) !== caller);
  if (notMine !== undefined) {
    const leader = tree.leaderOf(notMine);
    const where = leader === undefined ? (notMine === tree.lead ? 'is the lead' : 'is not on the team') : `is led by ${leader}`;
    return { ok: false, problem: `${notMine} ${where}: ${caller} promotes only among the sessions it leads directly` };
  }
  const problem = membersProblem(subLead, members);
  if (problem !== undefined) {
    return { ok: false, problem };
  }
  const own = config.leads[caller] ?? [];
  const left = caller === tree.lead ? config.leads : withList(config.leads, caller, own.filter((id) => !members.includes(id)));
  return { ok: true, value: withList(left, subLead, [...(config.leads[subLead] ?? []), ...members]) };
}

/** `caller` takes back the whole group of `subLead`, one of its direct members: the sub-lead's members become the caller's. */
export function demoted(config: TreeConfig, caller: string, subLead: string): Checked<Leads> {
  const tree = new LeadTree(config);
  const members = config.leads[subLead];
  if (members === undefined) {
    return { ok: false, problem: `${subLead} is not a sub-lead: it leads no one` };
  }
  const leader = tree.leaderOf(subLead);
  if (leader !== caller) {
    return { ok: false, problem: `${subLead} is led by ${leader ?? 'no one'}: only its own leader demotes it` };
  }
  const without = withList(config.leads, subLead, []);
  return { ok: true, value: caller === tree.lead ? without : withList(without, caller, [...(config.leads[caller] ?? []), ...members]) };
}

/** What a session's retire does to the tree: the next `leads`, and its members, who now answer to its leader. */
export interface LeadsAfterRetire {
  readonly leads: Leads;
  /** Its members, now led by `to`; empty when it led no one. */
  readonly members: readonly string[];
  /** Its own leader, who takes its members. */
  readonly to: string;
}

/**
 * `leads` without `id`, off the team: it leaves its sub-lead's list (a list left empty is dropped), and its own members,
 * if it led any, go to its leader. Undefined when the tree does not name it, so the config stays untouched; the lead
 * itself is never retired (its role names it), so a leader always exists.
 */
export function leadsAfterRetire(config: TreeConfig, id: string): LeadsAfterRetire | undefined {
  const members = config.leads[id] ?? [];
  const to = new LeadTree(config).leaderOf(id);
  const listed = Object.values(config.leads).some((list) => list.includes(id));
  if (to === undefined || (members.length === 0 && !listed)) {
    return undefined;
  }
  const without = withList(config.leads, id, []);
  const leads = to === config.roles.lead ? without : withList(without, to, [...(without[to] ?? []).filter((member) => member !== id), ...members]);
  return { leads, members, to };
}
