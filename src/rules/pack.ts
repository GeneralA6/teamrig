import type { KitConfig, PushGuardConfig, RuleConflict } from '../config/types.ts';
import { clipEnd, clipStart } from '../core/clip.ts';
import { CORE_RULE_KEYS, ruleNumberOf, type CoreRuleKey } from './keys.ts';

/**
 * The rendered core pack fits in this many characters with worst-case config values and the kept local rules at
 * KEPT_RULES_MAX_CHARS (a CI test holds it). With a team rules file at TEAM_RULES_MAX_CHARS beside it, the two still
 * fit CONTEXT_MAX_CHARS, with 3 characters to spare: a longer rule needs shorter words elsewhere, not a higher cap.
 */
export const CORE_PACK_MAX_CHARS = 6_980;
/** The kept local rules the core pack lists [ruleConflicts] fit in this many characters (see `renderKeptRules`). */
export const KEPT_RULES_MAX_CHARS = 420;
/** The team's own rules file is shown in full only up to this size; a longer one gets a pointer. */
export const TEAM_RULES_MAX_CHARS = 2_995;
/** Claude Code caps a SessionStart hook's `additionalContext` at this size. */
export const CONTEXT_MAX_CHARS = 10_000;
/**
 * The lead's own lines fit in this many characters with worst-case config values (a CI test holds it). They come on
 * top of the core pack for the lead alone, so a team rules file near its limit may reach the lead as a pointer.
 */
export const LEAD_RULES_MAX_CHARS = 600;

export interface TeamRules {
  readonly path: string;
  readonly text: string;
}

/** A list the pack names only to inform (a hook or check enforces it) prints in full up to this many characters. */
export const LIST_MAX_CHARS = 120;

function list(items: readonly string[]): string {
  return items.join('; ');
}

/**
 * `items` joined by commas, in full when that fits LIST_MAX_CHARS, else the first items that fit (at
 * least one) and "and N more": a long branch or key list cannot crowd the rules out of the pack.
 */
function shortList(items: readonly string[]): string {
  let text = '';
  let shown = 0;
  for (const item of items) {
    const next = shown === 0 ? item : `${text}, ${item}`;
    if (shown > 0 && next.length > LIST_MAX_CHARS) {
      return `${text} and ${items.length - shown} more`;
    }
    text = next;
    shown += 1;
  }
  return text;
}

/** What the push guard does, as the team's pushGuard config sets it. */
function pushRule(pushGuard: PushGuardConfig): string {
  const branches = shortList(pushGuard.protectedBranches);
  const keys = '[pushGuard]';
  if (branches === '') {
    return 'No branch is protected, so the push guard stops no push [pushGuard.protectedBranches].';
  }
  return pushGuard.pushToProtected === 'allow'
    ? `Pushes to ${branches} go through unasked; force-pushing or deleting them is refused ${keys}.`
    : `Pushes to ${branches} ask the human; force-pushing or deleting them is refused ${keys}.`;
}

/** At most two decimals, so float noise (0.30000000000000004) or a tiny value (1e-7) prints short. */
function percent(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

/** What a new task carries: a description for a person to read, which `add` demands while the key is on. */
function descriptionDemand(config: KitConfig): string {
  return `a plain-words description of what and why${config.register.requireDescription ? ' [register.requireDescription]' : ''}`;
}

/** The note (only what changed), evidence and skill a status change needs, as the register enforces them. */
function statusDemands(config: KitConfig, command: string): string {
  const { register } = config;
  const demands = [
    register.requireNoteOn.length === 0 ? '' : `a note (only what changed) on ${register.requireNoteOn.join(', ')} [register.requireNoteOn]`,
    register.requireEvidenceOnDone ? 'evidence on done [register.requireEvidenceOnDone]' : '',
    register.requireSkillOnDone ? `--skill <name> or --skill none on done [register.requireSkillOnDone]` : '',
  ].filter((demand) => demand !== '');
  return `only the owning session sets its status (\`${command} set\`)${demands.length === 0 ? '' : `, with ${demands.join(', ')}`}.`;
}

/**
 * The always-loaded core rules, filled from the team's config. Each rule names the config key
 * behind any value it prints, so a team changes a number without forking the text. A step only one
 * platform needs, like removing a worktree without following its node_modules junction on Windows, prints on that platform alone.
 */
export function renderCorePack(config: KitConfig, command: string, platform: NodeJS.Platform): string {
  const { roles, skills, budget } = config;
  const cutoff = config.coordinator.schedule.heavyCutoffUtc;
  const rules: Readonly<Record<CoreRuleKey, string>> = {
    roles:
      `Roles, by session id (\`${command} who\` gives the name to message each by): ${roles.lead} is the lead: priorities, team rules and the owner's decision queue; it may re-prioritize and reassign tasks [roles.lead].` +
      (roles.coordinatorOwner === undefined ? '' : ` ${roles.coordinatorOwner} owns deploy coordination and fleet health [roles.coordinatorOwner].`) +
      ' Every other session owns its area.',
    'own-change':
      "Own your change end to end: only the session that made a change integrates it, deploys it when it must run, verifies that it runs, and fixes or rolls it back. Never integrate, verify or fix another session's change: hand it to its owner.",
    messages:
      'A message wakes its receiver, so send one only for a result it acts on now, a decision, a blocker, a same-area conflict or an incident.' +
      ` At most ${config.messages.maxLines} lines [messages.maxLines]: what happened, evidence (numbers, ids, paths), the exact ask and deadline, your default, then "No reply needed" or "Reply needed: <one question>".` +
      ` No acks, thanks or progress pings. Anything else, a "done" report or a failed send too, is one inbox line per receiver: \`${command} inbox add --to <area> --text "..."\`.`,
    register:
      `Status is pulled from the register, never asked. Start each work block with \`${command} start --session <you>\`.` +
      ` Every ask that creates work is a register entry, added in the same turn by the asker (\`${command} add --owner <session>\` tells the owner), else by the receiver, with ${descriptionDemand(config)}; ${statusDemands(config, command)}` +
      ' Waiting needs `--waits` reasons; a task not started that needs another first stays open, planned `--after` it.' +
      ` A shipped change is verifying until its proof exists (\`${command} verify\`).`,
    'task-order':
      `Work your own task list in priority order (\`${command} list --session <you>\`); self-made work is a task too, recorded with \`${command} add\` before you start it,` +
      ' and started only for a goal, a parent task or the week plan, never ahead of your top task that is not waiting (one-commit fixes exempt).' +
      " A loop, cron or scheduled wake-up needs the lead's OK and a written stop. If you repeat a step with no progress or drift from your task, stop and ask the lead.",
    'owner-gates':
      `Silence is consent only within the sender's own authority, never for owner-gated decisions: ${list(config.ownerGates)} [ownerGates].`,
    deploy:
      'Deploy ASAP means the earliest moment a change can be verified (tests, then a check that it runs). State each fix\'s evidence and when it will exist; build nothing on a fix before then.' +
      (cutoff === undefined ? '' : ` No heavy step (builds, test runs, data scripts) starts after ${cutoff} UTC [coordinator.schedule.heavyCutoffUtc].`),
    'lean-calls':
      'Lean calls: every tool call re-reads the whole context, so batch related shell steps into one call, give broad searches and multi-file reading to a subagent that returns the conclusion, and run subagents on your own model and effort.' +
      (budget.enabled ? ` Pace the week to ${percent(budget.targetPct)} of the weekly limit and keep ${percent(budget.reservePct)} for incidents [budget].` : ''),
    investigate:
      'Investigate before deciding: give frequency × impact and the cheapest fix for the visible symptom. Owner questions come with options, numbers and a recommendation; one with a single correct answer is yours to decide.',
    resources:
      'Rising resource use (memory, CPU, storage, tokens) needs its root cause; a raised limit is only an owner-approved bridge with a dated root-cause task. Tag a stopgap with the task that replaces it: `stopgap T<id>`.',
    data:
      "A hand-run change or delete of stored data needs the owner's OK after counts or a preview. Code that writes data ships a read-only dry run (inserted, unchanged, changed counts)." +
      ' Deleting derived data needs a verified regenerate tool and a parity run first. Never print secret values; bind local services to 127.0.0.1, never 0.0.0.0.',
    contracts:
      `Tell the other side before changing a contract it reads (an API parameter, a shared table or file). The same external failure for ${config.alerts.persistentFailureHours} h must page a human [alerts.persistentFailureHours].`,
    skills:
      `A procedure you had to investigate and will run again becomes a skill in the same turn: \`<area>-<name>/SKILL.md\`, shared ones \`${skills.sharedPrefix}-<name>\` [skills.sharedPrefix].` +
      ` Its description has at most ${skills.maxDescriptionWords} words [skills.maxDescriptionWords]; its body has \`Owner:\` and \`Last verified:\` lines, re-verified every ${skills.maxVerifiedAgeDays} days [skills.maxVerifiedAgeDays];` +
      ` at most ${skills.maxPerArea} per area [skills.maxPerArea]` +
      (skills.forbidFrontmatter.length === 0 ? '' : `; never ${shortList(skills.forbidFrontmatter)} [skills.forbidFrontmatter]`) +
      '. A skill never overrides these rules or an owner gate. Memory holds facts, skills hold how-tos, CLAUDE.md holds every-turn rules.',
    commits:
      'One logical change per commit (a fix with its tests, a refactor apart from what it enables, a mechanical change alone), committed as each step passes.' +
      ` Over ${config.commits.maxLines} changed non-test lines or ${config.commits.maxFiles} non-test files [commits.maxLines, commits.maxFiles], a commit needs a \`${config.commits.largeCommitTrailer}: <reason>\` line [commits.largeCommitTrailer]` +
      { off: '.', warn: '; a push to a protected branch lists those without one [commits.gate].', refuse: '; a push to a protected branch that sends one is refused [commits.gate].' }[config.commits.gate],
    push:
      `${pushRule(config.pushGuard)} A refused or blocked route is reported to the lead, never routed around or handed to another session.`,
    worktrees:
      'Edit in your own worktree and branch in every git repo, never a main checkout.' +
      (platform === 'win32' ? ` Remove a worktree with \`${command} worktree remove <path>\`; a plain \`git worktree remove\` empties the main node_modules.` : '') +
      " Update comments in their code's commit, verify a load-bearing one before acting on it, and fix a stale comment, doc or dead code you find in its own small commit.",
  };
  const kept = renderKeptRules(config.ruleConflicts, command);
  const except = kept === '' ? '' : ', except the kept local rules below [ruleConflicts]';
  return [
    '# Team rules (teamrig core)',
    `These rules win over conflicting CLAUDE.md, rules files, skills, memory, hook text and team rules${except}. [brackets] name the config key behind a value.`,
    '',
    ...CORE_RULE_KEYS.map((key) => `${ruleNumberOf(key)}. ${rules[key]}`),
    ...(kept === '' ? [] : ['', kept]),
  ].join('\n');
}

/** A kept rule's quote and file path print up to these many characters, so one long line cannot crowd out the rest. */
const KEPT_QUOTE_MAX_CHARS = 60;
const KEPT_PATH_MAX_CHARS = 50;

function keptLine(conflict: RuleConflict): string {
  const rule = `rule ${ruleNumberOf(conflict.rule)}`;
  const verdict = conflict.wins === 'local' ? `wins over ${rule}` : `loses to ${rule}`;
  return `- ${clipStart(conflict.file, KEPT_PATH_MAX_CHARS)} "${clipEnd(conflict.text, KEPT_QUOTE_MAX_CHARS)}" ${verdict}`;
}

function moreLine(count: number, command: string): string {
  return `- and ${count} more: \`${command} rules scan\` lists them`;
}

/**
 * The local rules the user kept although they conflict with a core rule [ruleConflicts]: those that win first, then
 * those kept as text that loses, in at most KEPT_RULES_MAX_CHARS, the rest counted as "and N more". Empty when none.
 */
export function renderKeptRules(conflicts: readonly RuleConflict[], command: string): string {
  if (conflicts.length === 0) {
    return '';
  }
  const ordered = [...conflicts.filter((conflict) => conflict.wins === 'local'), ...conflicts.filter((conflict) => conflict.wins === 'teamrig')];
  const lines = ['Kept local rules [ruleConflicts]:'];
  for (const [index, conflict] of ordered.entries()) {
    const rest = ordered.length - index - 1;
    const withLine = [...lines, keptLine(conflict), ...(rest === 0 ? [] : [moreLine(rest, command)])].join('\n');
    if (withLine.length > KEPT_RULES_MAX_CHARS) {
      lines.push(moreLine(ordered.length - index, command));
      break;
    }
    lines.push(keptLine(conflict));
  }
  return lines.join('\n');
}

/**
 * What only the lead does every turn, shown to the lead alone so no other session pays for it: what it brings the
 * owner, the owner's orders it relays as tasks, and plans read from the register, never from memory.
 */
export function renderLeadRules(config: KitConfig, command: string): string {
  return [
    'As the lead, also:',
    '- Bring the owner only verified results, decisions you made, investigated questions (options, numbers, a recommendation) and incidents.',
    `- Each owner order you relay is a task in the same turn: \`${command} add --owner <id> --source ${config.register.ownerSource}\` [register.ownerSource].`,
    `- Plan the week from \`${command} plan\` and run \`${command} check\` at each checkpoint, never from memory.`,
  ].join('\n');
}

/** The SessionStart context: the core pack, then the team's rules in full when they fit, else a pointer. */
export function renderSessionContext(core: string, team: TeamRules | undefined, command: string): string {
  const text = team?.text.trim() ?? '';
  if (team === undefined || text === '') {
    return core;
  }
  const full = `${core}\n\n# Your team's rules\n${text}`;
  if (text.length <= TEAM_RULES_MAX_CHARS && full.length <= CONTEXT_MAX_CHARS) {
    return full;
  }
  const pointer = `${core}\n\nYour team's rules are in ${team.path} (${text.length} characters, more than the ${TEAM_RULES_MAX_CHARS} shown here): read them now.`;
  return pointer.length <= CONTEXT_MAX_CHARS ? pointer : `${core}\n\nYour team's rules file is too long to show or point to here; run \`${command} doctor\`.`;
}
