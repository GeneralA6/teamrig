import type { Roster } from '../config/roster.ts';
import { describeNameClash, describeTreeProblem, type NameClash, type TreeProblem } from '../config/tree.ts';
import type { KitConfig } from '../config/types.ts';
import { formatUtcMinute, MS_PER_DAY, parseUtcDeadline, shortUtc } from '../core/time.ts';
import { unreadSince } from '../inbox/inbox.ts';
import type { Unread } from '../inbox/unread.ts';
import type { RenameLogRead } from '../names/rename.ts';
import { describeRequirement, type RequirementProblem } from '../requirements/requirements.ts';
import { TEAM_RULES_MAX_CHARS } from '../rules/pack.ts';

/**
 * Days an inbox may wait with unread lines and no read before doctor flags it. Hard-coded for now;
 * a candidate config key if teams want it tighter or looser.
 */
export const UNREAD_INBOX_DAYS = 7;

/**
 * - `requirement`: something teamrig needs beside itself is missing or too old (git, Claude Code, Node.js);
 * - `name-gone`: a name of a session no longer on the team;
 * - `name-shared`: a current name two sessions share, or a session's former name another holds now;
 * - `name-config`: a config name the rename log never gave the session (the config was edited to rename);
 * - `rename-log`: damaged or newer lines in the rename log;
 * - `inbox-orphan`: an inbox no session on the team reads;
 * - `inbox-unread`: unread lines and no read for over `UNREAD_INBOX_DAYS` days;
 * - `rules-long`: a rules.md longer than a session is shown at start;
 * - `tree-id`, `tree-parent`, `tree-loop`, `tree-depth`, `tree-children`: a broken link in the
 *   team's tree of teams (see `TreeProblem`);
 * - `name-two-teams`: a session name this team shares with another team, though names are machine-wide.
 */
export type FindingKind =
  | 'requirement'
  | 'name-gone'
  | 'name-shared'
  | 'name-config'
  | 'rename-log'
  | 'inbox-orphan'
  | 'inbox-unread'
  | 'rules-long'
  | TreeProblem['kind']
  | 'name-two-teams';

export interface Finding {
  readonly kind: FindingKind;
  readonly detail: string;
}

export interface DoctorInput {
  /** What teamrig lacks on this machine (`RequirementsCheck`). */
  readonly requirements: readonly RequirementProblem[];
  readonly roster: Roster;
  /** The config's `names`, to spot a rename made by editing the config. */
  readonly configNames: KitConfig['names'];
  readonly renameLog: RenameLogRead & { readonly path: string };
  /** Every inbox, as `inbox status` reads it. */
  readonly inboxes: readonly Unread[];
  /** The team's rules.md and its length, when it exists. */
  readonly teamRules: { readonly path: string; readonly chars: number } | undefined;
  /** The problems of the team's tree of teams, and the session names it shares with other teams. */
  readonly tree: { readonly problems: readonly TreeProblem[]; readonly clashes: readonly NameClash[] };
  readonly now: Date;
  /** The CLI name the fixes tell the user to run. */
  readonly command: string;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Names that find the wrong session, or none: a removed session's, a shared current one, a former one taken over. */
function nameFindings(roster: Roster, command: string): Finding[] {
  const findings: Finding[] = [];
  const gone = new Map<string, string[]>();
  const shared = new Set<string>();
  for (const [name, holder] of roster.allNames()) {
    if (!roster.ids.includes(holder)) {
      gone.set(holder, [...(gone.get(holder) ?? []), name]);
      continue;
    }
    const current = roster.idsCalled(name);
    if (current.length > 1) {
      shared.add(name);
    } else if (current.length === 1 && !current.includes(holder)) {
      findings.push({ kind: 'name-shared', detail: `${name} was a name of ${holder} but is now the name of ${current.join(', ')}, so it no longer finds ${holder}` });
    }
  }
  for (const name of shared) {
    const ids = roster.idsCalled(name).join(', ');
    findings.push({ kind: 'name-shared', detail: `${name} is the name of ${ids}, so commands refuse it: give each its own with \`${command} rename\`` });
  }
  for (const [id, names] of gone) {
    const these = plural(names.length, 'was a name', 'were names');
    findings.push({ kind: 'name-gone', detail: `${names.join(', ')} ${these} of ${id}, which is no longer on the team: commands refuse them, filters read them as ${id}` });
  }
  return findings;
}

/** A config name the rename log never gave the session: someone edited the config to rename it, and the log wins. */
function configFindings(input: DoctorInput): Finding[] {
  const { roster, renameLog, command } = input;
  return Object.entries(input.configNames).flatMap(([id, configured]): Finding[] => {
    const current = roster.nameOf(id);
    const logged = renameLog.renames.some((rename) => rename.id === id && (rename.from === configured || rename.to === configured));
    if (current === undefined || current === configured || logged) {
      return [];
    }
    const detail = `the config names ${id} "${configured}", but the rename log calls it ${current} and the log wins: to rename it, run \`${command} rename ${id} ${configured}\``;
    return [{ kind: 'name-config', detail }];
  });
}

function renameLogFindings(input: DoctorInput): Finding[] {
  const { path, unreadable, newer } = input.renameLog;
  const findings: Finding[] = [];
  if (unreadable > 0) {
    findings.push({ kind: 'rename-log', detail: `${path} has ${unreadable} damaged line(s), skipped: the names they record do not resolve until fixed` });
  }
  if (newer > 0) {
    findings.push({ kind: 'rename-log', detail: `${path} has ${newer} line(s) from a newer ${input.command}, skipped: no rename can be recorded until ${input.command} is updated` });
  }
  return findings;
}

/** When an inbox started waiting: its last read, else its first unread line; undefined when neither is known. */
function waitingSince(unread: Unread): Date | undefined {
  if (unread.mark !== null) {
    return new Date(unread.mark.at);
  }
  const posted = unreadSince(unread);
  return posted === undefined ? undefined : parseUtcDeadline(posted);
}

/** Inboxes nobody reads: one keyed by no session id on the team, or unread lines with no read for days. */
function inboxFindings(input: DoctorInput): Finding[] {
  const { roster, now } = input;
  return input.inboxes.flatMap((unread): Finding[] => {
    const { area, mark } = unread;
    const count = unread.lines.length;
    if (!roster.ids.includes(area)) {
      const found = roster.lookup(area);
      const hint = found.ok ? `; ${area} is a name of ${found.id}, whose inbox is keyed by its id` : '';
      const detail = `inbox ${area} (${count} unread) is no session's: inboxes are keyed by session id, so nobody reads it${hint}; nothing moves its lines`;
      return [{ kind: 'inbox-orphan', detail }];
    }
    const since = waitingSince(unread);
    if (count === 0 || (since !== undefined && now.getTime() - since.getTime() <= UNREAD_INBOX_DAYS * MS_PER_DAY)) {
      return [];
    }
    const read = mark === null ? 'has never read it' : `last read it ${shortUtc(formatUtcMinute(new Date(mark.at)))}`;
    return [{ kind: 'inbox-unread', detail: `${area} has ${count} unread line(s) and ${read}: over ${UNREAD_INBOX_DAYS} days with no read` }];
  });
}

function rulesFindings(input: DoctorInput): Finding[] {
  const rules = input.teamRules;
  if (rules === undefined || rules.chars <= TEAM_RULES_MAX_CHARS) {
    return [];
  }
  const detail = `${rules.path} is ${rules.chars} characters, more than the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten it to keep it in every session's context`;
  return [{ kind: 'rules-long', detail }];
}

function treeFindings({ tree, command }: DoctorInput): Finding[] {
  return [
    ...tree.problems.map((problem): Finding => ({ kind: problem.kind, detail: describeTreeProblem(problem, command) })),
    ...tree.clashes.map((clash): Finding => ({ kind: 'name-two-teams', detail: describeNameClash(clash, command) })),
  ];
}

/**
 * The team's health checks: names that find the wrong session or none, a damaged rename log,
 * inboxes nobody reads, rules too long to show, and a broken tree of teams or a session name two
 * teams use. It reads only; every fix is the user's.
 */
export function doctorFindings(input: DoctorInput): Finding[] {
  return [
    ...input.requirements.map((problem): Finding => ({ kind: 'requirement', detail: describeRequirement(problem, input.command) })),
    ...nameFindings(input.roster, input.command),
    ...configFindings(input),
    ...renameLogFindings(input),
    ...inboxFindings(input),
    ...rulesFindings(input),
    ...treeFindings(input),
  ];
}

export function formatFinding(finding: Finding): string {
  return `WARN ${finding.kind} ${finding.detail}`;
}
