import { formatAddress, type SessionAddress } from '../core/address.ts';
import type { KitConfig } from './types.ts';

/**
 * The team's lead tree (T781): `roles.lead` at the top, and each sub-lead in `leads` over the sessions it lists. A
 * session's leader is the sub-lead that lists it, else the lead; the lead has none on its team. The parser keeps the tree
 * whole (one leader per session, the lead never a member, no cycles), so every walk here ends at the lead. On a child
 * team, `above` is the parent team's lead (T1140), who approves the lead's own work, as the lead approves its members'.
 */
export class LeadTree {
  readonly lead: string;
  /** The parent team's lead as `<team>/<id>`, on a child team; undefined on a root team. */
  readonly above: string | undefined;
  private readonly sessions: readonly string[];
  /** Each listed member to the sub-lead that leads it. */
  private readonly listedLeader: ReadonlyMap<string, string>;
  private readonly subLeads: ReadonlySet<string>;

  constructor(config: Pick<KitConfig, 'sessions' | 'roles' | 'leads'>, above?: SessionAddress) {
    this.lead = config.roles.lead;
    this.above = above === undefined ? undefined : formatAddress(above);
    this.sessions = config.sessions;
    this.subLeads = new Set(Object.keys(config.leads));
    this.listedLeader = new Map(Object.entries(config.leads).flatMap(([subLead, members]) => members.map((member) => [member, subLead] as const)));
  }

  /** The session's direct leader: its sub-lead, else the lead; undefined for the lead and for an id not on the team. */
  leaderOf(id: string): string | undefined {
    if (id === this.lead || !this.sessions.includes(id)) {
      return undefined;
    }
    return this.listedLeader.get(id) ?? this.lead;
  }

  /** The leaders above the session, nearest first, ending at the lead; empty for the lead itself. */
  chainOf(id: string): string[] {
    const chain: string[] = [];
    // The parser refuses cycles; the seen set only keeps a hand-built config from looping.
    const seen = new Set([id]);
    for (let leader = this.leaderOf(id); leader !== undefined && !seen.has(leader); leader = this.leaderOf(leader)) {
      chain.push(leader);
      seen.add(leader);
    }
    return chain;
  }

  /**
   * Whose decision or approval a session's task may wait on, besides the human owner: its leaders, nearest first, so
   * the lead always; the lead's own task waits on the parent team's lead on a child team, else on the lead.
   */
  approversOf(id: string): string[] {
    const chain = this.chainOf(id);
    if (chain.length > 0) {
      return chain;
    }
    return id === this.lead && this.above !== undefined ? [this.above] : [this.lead];
  }

  /** The sessions the leader leads directly, in config order: for the lead, every session no sub-lead lists. */
  membersOf(leader: string): string[] {
    return this.sessions.filter((id) => this.leaderOf(id) === leader);
  }

  /** Every session under the leader, at any depth, in config order. */
  groupOf(leader: string): string[] {
    return this.sessions.filter((id) => this.chainOf(id).includes(leader));
  }

  /** Whether the session leads anyone: the lead, or a sub-lead. */
  isLeader(id: string): boolean {
    return id === this.lead || this.subLeads.has(id);
  }

  /** Whether `leader` is above `id` in the tree, at any depth. */
  leads(leader: string, id: string): boolean {
    return this.chainOf(id).includes(leader);
  }

  /**
   * The sub-lead a message from `sender` to `receiver` skips: the one right below the sender on the receiver's chain.
   * Undefined when the sender is the receiver's direct leader, or not above the receiver at all.
   */
  routeVia(sender: string, receiver: string): string | undefined {
    const chain = this.chainOf(receiver);
    const at = chain.indexOf(sender);
    return at > 0 ? chain[at - 1] : undefined;
  }
}
