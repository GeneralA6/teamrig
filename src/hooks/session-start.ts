import { LeadTree } from '../config/lead-tree.ts';
import type { ConfigLoad } from '../config/load.ts';
import { Roster } from '../config/roster.ts';
import type { TreePlace } from '../config/tree.ts';
import { formatAddress } from '../core/address.ts';
import { ENV, KIT_NAME } from '../core/home.ts';
import { isReservedName, RESERVED_RULE } from '../core/ids.ts';
import type { Rename } from '../names/rename.ts';
import { CONTEXT_MAX_CHARS, renderCorePack, renderLeadRules, teamRulesPart, type KeptRule, type RulesClock, type TeamRules } from '../rules/pack.ts';

/**
 * A long start note: shown in full when the context has room for it, else as `pointer`, one line naming the command
 * that prints it, so the context stays inside CONTEXT_MAX_CHARS (T1376).
 */
export interface CuttableNote {
  readonly text: string;
  readonly pointer: string;
}

/** A line of the start's notes: a short one always shown, or a long one that may come as its pointer. */
type StartNote = string | CuttableNote;

export interface SessionStartInput {
  readonly team: string;
  readonly load: ConfigLoad;
  /** The `rules.md` of each team above the session's, root first, then its own team's; those that exist. */
  readonly teamRules: readonly TeamRules[];
  /** The kept local rules [ruleConflicts] of each team above the session's, root first; its own team's are in `load`. */
  readonly keptRulesAbove: readonly KeptRule[];
  /** The team's rename log, so the session learns its current name and old names still find it. */
  readonly renames: readonly Rename[];
  /** What the hook did with the session's Claude Code title, when there is something to say. */
  readonly titleNote: string | undefined;
  /** After a context refresh: where the session's handover is, so it reads it first. */
  readonly refreshNote: string | undefined;
  /**
   * After a context refresh or a compaction: the session's active tasks as the register holds them at this start
   * (hooks/live-tasks.ts), since its handover or the compaction summary may be older.
   */
  readonly liveTasksNote: CuttableNote | undefined;
  /** When the session runs on another model or effort than the team config asks: the line that says so. */
  readonly modelNote: string | undefined;
  /** When the session holds verifying tasks: `VERIFY <n>, oldest first:` and a row each (the first few), so it proves them. */
  readonly verifyNote: CuttableNote | undefined;
  /** When the session already runs in another Claude Code: the line that tells this second one to stop. */
  readonly duplicateNote: string | undefined;
  /** When the session starts in a Claude Code worktree: the shell forms its isolation refuses (hooks/worktree-note.ts). */
  readonly worktreeNote: string | undefined;
  /**
   * Who the session is: an id or any name it has had, from `$TEAMRIG_SESSION`, a `--session` flag, or
   * the area this Claude Code session last read its inbox as.
   */
  readonly session: string | undefined;
  /** Whether `$TEAMRIG_SESSION` holds `session`, so the session's commands find it without `--session`. */
  readonly sessionInEnv: boolean;
  /** Where the hook runs, so the rules print the steps only that platform needs. */
  readonly platform: NodeJS.Platform;
  /** When the rules are read and the machine's zone, which name the heavy cutoff on the team's clock. */
  readonly clock: RulesClock;
  /** Where the team sits in a tree of teams; undefined for a team on its own. */
  readonly tree: TreePlace | undefined;
  /** The CLI name the rules tell the session to run. */
  readonly command: string;
}

/** Whether the session the input names holds the team's lead role. */
function isLeadSession(roster: Roster, session: string | undefined): boolean {
  const found = session === undefined ? undefined : roster.lookup(session);
  return found !== undefined && found.ok && found.id === roster.holderOf('lead');
}

/**
 * Who this session is and whom to message. Session names are machine-wide in Claude Code, so the
 * session learns the exact names to use; an unknown value is never echoed, so the lines stay short.
 */
function identityLines(roster: Roster, leaders: LeadTree, input: SessionStartInput): string[] {
  const { command, session } = input;
  const lead = roster.holderOf('lead');
  const leadName = lead === undefined ? undefined : roster.nameOf(lead);
  const found = session === undefined ? undefined : roster.lookup(session);
  const names = `\`${command} who\` prints the name to message any session by; message only those names.`;
  const isLead = isLeadSession(roster, session);
  const tree = input.tree === undefined ? [] : [treeLine(input.tree, input, isLead)];
  if (found === undefined || !found.ok) {
    const why = session === undefined ? `No session is set ($${ENV.session})` : `$${ENV.session} does not name a session on this team`;
    const toLead = lead === undefined || leadName === undefined ? '' : reachNote(lead, leadName, true, command);
    return [`${why}: ask the user which session you are (\`${command} who\` lists them) and pass --session <id> to every \`${command}\` task and inbox command.${toLead}`, names, ...tree];
  }
  const roles = roster.rolesOf(found.id);
  const held = roles.length === 0 ? '' : `, roles: ${roles.join(', ')}`;
  const you = `You are the \`${found.id}\` session of team \`${input.team}\` (name \`${roster.nameOf(found.id) ?? found.id}\`${held}).`;
  const pass = input.sessionInEnv ? '' : ` $${ENV.session} is not set here, so pass --session ${found.id} to every \`${command}\` task and inbox command.`;
  return [`${you}${pass}${messageNote(roster, leaders, found.id, command)}`, names, ...tree];
}

/**
 * Whom the session messages: the lead, or for a sub-lead's member its own leader (T781), who takes up what it cannot
 * settle; nothing for the lead itself.
 */
function messageNote(roster: Roster, leaders: LeadTree, id: string, command: string): string {
  const leader = leaders.leaderOf(id);
  const name = leader === undefined ? undefined : roster.nameOf(leader);
  if (leader === undefined || name === undefined) {
    return '';
  }
  return reachNote(leader, name, leader === leaders.lead, command);
}

/**
 * How the session reaches its leader `id`, named `name`: by message, or by inbox line when Claude Code keeps the name
 * for itself (T1124), since every message sent to it fails.
 */
function reachNote(id: string, name: string, isLead: boolean, command: string): string {
  if (!isReservedName(name)) {
    return isLead ? ` Message the lead as \`${name}\`.` : ` Message your leader as \`${name}\`, who takes to the lead what it cannot settle.`;
  }
  const who = isLead ? 'the lead' : 'your leader, who takes to the lead what it cannot settle,';
  return ` Write to ${who} with \`${command} inbox add --to ${id} --text "..."\`: its name \`${name}\` ${RESERVED_RULE}.`;
}

/** A team config that loaded no rules: missing, or present but unreadable. */
export type UnloadedConfig = Exclude<ConfigLoad, { readonly status: 'loaded' }>;

/** The one line a start gets when the team config loaded no rules: why, and the command that fixes it. */
export function unloadedContext(team: string, load: UnloadedConfig, command: string): string {
  switch (load.status) {
    case 'missing':
      return `${KIT_NAME} is enabled here but team ${team} has no config at ${load.path}, so no team rules are loaded. Create it with: ${command} team create ${team} --sessions <id,id>`;
    case 'unreadable':
      return `${KIT_NAME} cannot read the config of team ${team} at ${load.path}, so no team rules are loaded. Run: ${command} config validate`;
  }
}

/**
 * How a session of a team in a tree escalates: a member through its own lead; a sub-team's lead to
 * its parent lead, up to the root's lead, the only one the user talks to, and splits the tasks that
 * lead hands it among its own sessions. A lead with sub-teams also learns how to read their registers
 * and hand them tasks.
 */
function treeLine(place: TreePlace, input: SessionStartInput, isLead: boolean): string {
  const { team, command } = input;
  if (!isLead) {
    return `Team \`${team}\` is part of the tree of teams under \`${place.root}\`: take anything outside your team to your lead, never to another team's sessions (\`${command} inbox add\` reaches every session of the tree, so keeping to your lead is up to you).`;
  }
  const { parentLead } = place;
  const up =
    parentLead === undefined
      ? `Team \`${team}\` is the root of a tree of teams: you are the one lead the user talks to, and the sub-team leads bring you their owner decisions.`
      : `Team \`${team}\` is a sub-team of \`${parentLead.team}\` in the tree under \`${place.root}\`: the user talks only to the root team's lead.` +
        ` Take owner decisions and cross-team issues to your parent lead \`${formatAddress(parentLead)}\` (name \`${parentLead.name}\`, inbox: \`${command} inbox add --to ${formatAddress(parentLead)}\`), who carries them up.` +
        ` Split each task it hands you among your sessions: \`${command} add --owner <id>\` gives one its part, and \`${command} open <id>\` starts it.`;
  const down =
    place.children.length === 0
      ? ''
      : ` Your sub-teams (${place.children.join(', ')}) answer to you: \`${command} list|check|plan --tree\` reads their registers, and \`${command} add --team <team>\` hands its lead a task.`;
  return up + down;
}

/**
 * The context, within CONTEXT_MAX_CHARS: past it Claude Code shows the session only a preview of the start and saves
 * the rest to a file (T1376). The rules and each short note always come; the team rules files fit next, beside each
 * long note's pointer (`teamRulesPart`); then each long note, in order, takes its full text while the room left
 * holds it. A team rules file wins over a long note: a rules pointer costs a read of the file, while a long note's
 * pointer names the `start` the session runs at each work block anyway.
 */
function fitContext(rules: string, notes: readonly StartNote[], files: readonly TeamRules[], command: string): string {
  const withNotes = (lines: readonly string[]): string => `${rules}\n\n${lines.join('\n')}`;
  const pointers = withNotes(notes.map((note) => (typeof note === 'string' ? note : note.pointer)));
  const team = teamRulesPart(files, pointers.length, command);
  let room = CONTEXT_MAX_CHARS - pointers.length - team.length;
  const shown: string[] = [];
  for (const note of notes) {
    if (typeof note === 'string') {
      shown.push(note);
      continue;
    }
    const grows = note.text.length - note.pointer.length;
    const fits = grows <= room;
    shown.push(fits ? note.text : note.pointer);
    room -= fits ? grows : 0;
  }
  return `${withNotes(shown)}${team}`;
}

/**
 * The SessionStart context: the core rules from the team config, the lead's own lines for the lead, who the
 * session is, where its team sits in a tree of teams, its notes (after a refresh its handover, after a refresh or a
 * compaction its live tasks), and the team's own rules, fitted to Claude Code's cap (`fitContext`). Without a usable
 * config it says why no rules are loaded, in one line.
 */
export function sessionStartContext(input: SessionStartInput): string {
  const { load, command } = input;
  if (load.status !== 'loaded') {
    return unloadedContext(input.team, load, command);
  }
  const roster = new Roster(load.config, input.team, input.renames);
  const notes: StartNote[] = identityLines(roster, new LeadTree(load.config), input);
  // A short note, so the size budget that may cut the team's rules.md or a long note never cuts it.
  if (input.duplicateNote !== undefined) {
    notes.push(input.duplicateNote);
  }
  if (input.refreshNote !== undefined) {
    notes.push(input.refreshNote);
  }
  if (input.liveTasksNote !== undefined) {
    notes.push(input.liveTasksNote);
  }
  if (input.titleNote !== undefined) {
    notes.push(input.titleNote);
  }
  if (input.modelNote !== undefined) {
    notes.push(input.modelNote);
  }
  if (input.verifyNote !== undefined) {
    notes.push(input.verifyNote);
  }
  if (input.worktreeNote !== undefined) {
    notes.push(input.worktreeNote);
  }
  if (load.newerVersion !== undefined) {
    notes.push(`The team config is version ${load.newerVersion}, from a newer ${KIT_NAME}: these rules are read best-effort.`);
  }
  if (load.issues.length > 0) {
    notes.push(`The team config has ${load.issues.length} problem(s), each read as its default; run: ${command} config validate`);
  }
  const core = renderCorePack(load.config, command, input.platform, input.clock, input.keptRulesAbove);
  const rules = isLeadSession(roster, input.session) ? `${core}\n\n${renderLeadRules(load.config, command)}` : core;
  return fitContext(rules, notes, input.teamRules, command);
}

/**
 * The hook's stdout: Claude Code adds `additionalContext` to the session's context and shows the
 * notices, when there are any, to the user as one `systemMessage`: the user alone can change the model
 * or the effort, or install what teamrig lacks.
 */
export function sessionStartOutput(context: string, notices: readonly (string | undefined)[] = []): string {
  const hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context };
  const shown = notices.filter((notice): notice is string => notice !== undefined);
  return JSON.stringify(shown.length === 0 ? { hookSpecificOutput } : { systemMessage: shown.join('\n'), hookSpecificOutput });
}
