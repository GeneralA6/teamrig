import type { KitConfig } from '../config/types.ts';
import { formatAddress, type SessionAddress } from '../core/address.ts';
import { SecretScanner } from '../core/secrets.ts';
import { postLine } from '../inbox/inbox.ts';
import { inboxDepsOf } from './commands/inbox.ts';
import { openKit, type Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import type { UrgentLine } from './urgent-line.ts';

/** A team as a command opened it: its folder and paths, and its config. */
export interface OpenTeam {
  readonly kit: Kit;
  readonly config: KitConfig;
}

/** The team a role holder sits on, as a line posted to the holder reaches it. */
interface HolderTeam extends OpenTeam {
  /** How the holder's inbox names a sender of the posting team: its bare id at home, `<team>/<id>` on a team above. */
  sender(id: string): string;
}

type HolderTeamResult ={ readonly ok: true; readonly holder: HolderTeam } | { readonly ok: false; readonly problem: string };

/**
 * The team of a role's holder (roleHolderOf): the posting team itself, or a team above it that a child team leaves
 * the role to (T1143); a team above with no config to read gives the problem instead, for the poster to warn about.
 */
async function holderTeamOf(runtime: CliRuntime, own: OpenTeam, holder: SessionAddress): Promise<HolderTeamResult> {
  const team = own.kit.paths.team;
  const sender = (id: string): string => sessionNameOn(holder.team, team, id);
  if (holder.team === team) {
    return { ok: true, holder: { kit: own.kit, config: own.config, sender } };
  }
  const kit = await openKit(runtime, holder.team);
  if (kit.load.status !== 'loaded') {
    return { ok: false, problem: `no team ${holder.team} with a config in this kit home` };
  }
  return { ok: true, holder: { kit, config: kit.load.config, sender } };
}

/** How team `reader` names session `id` of team `team`: its bare id at home, `<team>/<id>` on another team. */
export function sessionNameOn(reader: string, team: string, id: string): string {
  return reader === team ? id : formatAddress({ team, id });
}

/** A line for a role's holder: the session of the posting team that sends it, and what it says. */
export interface HolderLine {
  readonly from: string;
  readonly text: string;
}

/** Posts a line on a team, to its inbox (postInboxLine) or with a wake too (urgent-line.ts); why it was not posted, else undefined. */
export type TeamPoster = (runtime: CliRuntime, kit: Kit, config: KitConfig, line: UrgentLine) => Promise<string | undefined>;

/** Posts a line to a team's inbox; why the inbox refused it (a secret pattern, not one line), else undefined. */
export function postInboxLine(runtime: CliRuntime, kit: Kit, config: KitConfig, line: UrgentLine): Promise<string | undefined> {
  return postLine(inboxDepsOf(runtime, kit.paths).inboxes, new SecretScanner(config.register.secretPatterns), { ...line, now: new Date(runtime.clock.now()) });
}

/**
 * Posts a line to a role's holder on whichever team it sits (holderTeamOf), its sender named as that team names the
 * posting team's sessions, through `post`; why it was not posted, a holder team with no config included, else undefined.
 */
export async function postToHolder(runtime: CliRuntime, own: OpenTeam, holder: SessionAddress, line: HolderLine, post: TeamPoster = postInboxLine): Promise<string | undefined> {
  const found = await holderTeamOf(runtime, own, holder);
  if (!found.ok) {
    return found.problem;
  }
  return post(runtime, found.holder.kit, found.holder.config, { to: holder.id, from: found.holder.sender(line.from), text: line.text });
}
