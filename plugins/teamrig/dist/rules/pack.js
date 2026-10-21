import { heavyCutoffSpan } from "../coordinator/schedule.js";
import { clipEnd, clipStart } from "../core/clip.js";
import { TimeZone } from "../core/zone.js";
import { CORE_RULE_KEYS, ruleNumberOf } from "./keys.js";
import { DECISION_MARKER } from "../tabs/status.js";
import { helperDefaultClause } from "./helper-default.js";
/**
 * The rendered core pack fits in this many characters with worst-case config values and the kept local rules at
 * KEPT_RULES_MAX_CHARS (a CI test holds it). With a team rules file at TEAM_RULES_MAX_CHARS beside it, the two still
 * fit CONTEXT_MAX_CHARS, with 3 characters to spare: a longer rule needs shorter words elsewhere, not a higher cap,
 * unless it takes over text a team's rules file carried, when the cap moves over from TEAM_RULES_MAX_CHARS with it.
 */
export const CORE_PACK_MAX_CHARS = 7_225;
/** The kept local rules the core pack lists [ruleConflicts] fit in this many characters (see `renderKeptRules`). */
export const KEPT_RULES_MAX_CHARS = 420;
/** The team's own rules file is shown in full only up to this size; a longer one gets a pointer. */
export const TEAM_RULES_MAX_CHARS = 2_750;
/** Claude Code caps a SessionStart hook's `additionalContext` at this size. */
export const CONTEXT_MAX_CHARS = 10_000;
/**
 * The lead's own lines fit in this many characters with worst-case config values (a CI test holds it). They come on
 * top of the core pack for the lead alone, so a team rules file near its limit may reach the lead as a pointer.
 */
export const LEAD_RULES_MAX_CHARS = 700;
/** A list the pack names only to inform (a hook or check enforces it) prints in full up to this many characters. */
export const LIST_MAX_CHARS = 120;
function list(items) {
    return items.join('; ');
}
/**
 * `items` joined by commas, in full when that fits LIST_MAX_CHARS, else the first items that fit (at
 * least one) and "and N more": a long branch or key list cannot crowd the rules out of the pack.
 */
function shortList(items) {
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
function pushRule(pushGuard, hookAsks) {
    const branches = shortList(pushGuard.protectedBranches);
    const keys = '[pushGuard]';
    if (branches === '') {
        return 'No branch is protected, so the push guard stops no push [pushGuard.protectedBranches].';
    }
    // Under `lead` the guard's refusal says how to ask the lead (src/hooks/push-guard.ts), so the rule stays short.
    return pushGuard.pushToProtected === 'lead'
        ? `Pushes to ${branches} ask the lead; force-pushing or deleting them is refused ${keys}.`
        : pushGuard.pushToProtected === 'allow'
            ? `Pushes to ${branches} go unasked; force-pushing or deleting them is refused ${keys}.`
            : hookAsks === 'refuse'
                ? `Every push to ${branches} is refused [pushGuard, prompts.hookAsks].`
                : `Pushes to ${branches} ask the human; force-pushing or deleting them is refused ${keys}.`;
}
/**
 * What a session does with a refused or blocked route. With hook asks off nobody answers a prompt, so the route waits
 * for the owner, as each refusal's own reason says (hooks/permission.ts), instead of waking the lead.
 */
function refusedRouteRule(hookAsks) {
    return hookAsks === 'refuse'
        ? 'A refused or blocked route waits on approval:owner; take your next task, never route around it or hand it off.'
        : 'A route refused, blocked or prompting unexpectedly is reported to the lead, never routed around or handed to another session.';
}
/** At most two decimals, so float noise (0.30000000000000004) or a tiny value (1e-7) prints short. */
function percent(value) {
    return `${Math.round(value * 100) / 100}%`;
}
/** What a new task carries: a description for a person to read, which `add` demands while the key is on. */
function descriptionDemand(config) {
    return `a plain-words description of what and why${config.register.requireDescription ? ' [register.requireDescription]' : ''}`;
}
/** The note (only what changed), evidence, skill and follow-ups a status change needs, as the register enforces them. */
function statusDemands(config, command) {
    const { register } = config;
    const demands = [
        register.requireNoteOn.length === 0 ? '' : `a note (only what changed) on ${[...new Set(register.requireNoteOn)].join(', ')} [register.requireNoteOn]`,
        register.requireEvidenceOnDone ? 'evidence on done [register.requireEvidenceOnDone]' : '',
        register.requireSkillOnDone ? '--skill <name>|none on done [register.requireSkillOnDone]' : '',
        register.requireFollowupsOn.length === 0
            ? ''
            : `--followups <tasks it leaves>|none on ${[...new Set(register.requireFollowupsOn)].join(', ')} [register.requireFollowupsOn]`,
    ].filter((demand) => demand !== '');
    return `only the owning session sets its status (\`${command} set\`)${demands.length === 0 ? '' : `, with ${demands.join(', ')}`}.`;
}
/**
 * Rule 3's times: on the team's clock, zone-marked. Off UTC it adds the zone's offset now, so a session converts
 * from UTC without a lookup, and keeps UTC for where UTC is the subject.
 */
function timesClause(zone, now) {
    const label = zone.label(now);
    if (label === 'UTC') {
        return " Write times on the team's clock, zone-marked (`04:00 UTC`) [timeZone].";
    }
    return ` Write times on the team's clock, zone-marked (\`04:00 ${label}\`, ${zone.utcOffset(now)} now); UTC only when UTC is the subject [timeZone].`;
}
/**
 * Rule 7's heavy-step sentence, `cutoff` the span no heavy step starts in, on the team's clock. A team that names a
 * repository for the coordinator [coordinator.repos] lands and runs its changes through it, so it gets the commands
 * too; a cutoff alone gets only its own sentence.
 */
function heavySteps(coordinator, command, cutoff) {
    const repos = Object.values(coordinator.repos);
    if (repos.length === 0) {
        return cutoff === undefined ? '' : ` No heavy step (builds, test runs, data scripts) starts ${cutoff} [coordinator.schedule.heavyCutoffUtc].`;
    }
    const roll = repos.some((repo) => repo.roll !== undefined) ? ` and run it with \`${command} roll\`` : '';
    return (` Run heavy steps (builds, test runs, data scripts) in the background through \`${command} heavy\`, a test run inside \`${command} test\`` +
        (cutoff === undefined ? '' : `, none starting ${cutoff} [coordinator.schedule.heavyCutoffUtc]`) +
        // Never `heavy -- git commit`: a repository's hooks take the lock themselves, and Claude Code's worktree guard
        // refuses that form in a worktree session (the guide's `teamrig heavy` section).
        `; a commit stays a plain \`git commit\`. Land a tested branch with \`${command} integrate\`${roll}, also in the background [coordinator.repos].`);
}
/**
 * The always-loaded core rules, filled from the team's config. Each rule names the config key
 * behind any value it prints, so a team changes a number without forking the text. A step only one
 * platform needs, like removing a worktree without following its node_modules junction on Windows, prints on that platform alone.
 * The heavy cutoff is named on the team's clock, for the day `clock.now` falls on.
 */
export function renderCorePack(config, command, platform, clock) {
    const { roles, skills, budget } = config;
    const cutoff = heavyCutoffSpan(clock.now.getTime(), config.coordinator.schedule.heavyCutoffUtc);
    const zone = TimeZone.resolve(config.timeZone, clock.machineZone);
    const cutoffSpan = cutoff === undefined ? undefined : zone.clockSpan(new Date(cutoff.from), new Date(cutoff.to));
    const rules = {
        roles: `Roles, by session id: ${roles.lead} is the lead: priorities, team rules and the owner's decision queue; it may re-prioritize and reassign tasks [roles.lead].` +
            (roles.coordinatorOwner === undefined ? '' : ` ${roles.coordinatorOwner} owns deploy coordination and fleet health [roles.coordinatorOwner].`) +
            (roles.securityReviewer === undefined ? '' : ` ${roles.securityReviewer} reviews privileged commands (\`${command} exec\`) [roles.securityReviewer].`) +
            ' Every other session owns its area; cross-area issues and clashes go to the lead.',
        'own-change': "Own your change end to end: only the session that made it integrates, deploys (when it must run), verifies and fixes or rolls it back; another session's change goes to its owner.",
        messages: 'A message wakes its receiver, so send one only for a result it acts on now, a decision, a blocker, a same-area conflict or an incident.' +
            ` At most ${config.messages.maxLines} lines [messages.maxLines]: what happened, evidence (numbers, ids, paths), the exact ask and deadline, your default, then "No reply needed" or "Reply needed: <one question>".` +
            ` No acks, thanks or progress pings. Anything else, a "done" report too, is one inbox line per receiver: \`${command} inbox add --to <area> --text "..."\`.` +
            timesClause(zone, clock.now),
        register: `Status is pulled from the register, never asked. Start each work block with \`${command} start --session <you>\`.` +
            ` Every ask that creates work is a register entry, added in the same turn by the asker (\`${command} add --owner <session>\` tells the owner), else by the receiver, with ${descriptionDemand(config)}; ${statusDemands(config, command)}` +
            ' Wait on a peer by its task.' +
            ` A shipped change is verifying until its proof exists (\`${command} verify\`).`,
        'task-order': `Work your own task list in priority order (\`${command} list --session <you>\`); self-made work is a task too, added with \`${command} add\` before you start it,` +
            ' and started only for a goal, a parent task or the week plan, never ahead of your top task that is not waiting (one-commit fixes exempt).' +
            " A loop, cron or scheduled wake-up needs the lead's OK and a written stop. If you repeat a step with no progress or drift from your task, stop and ask the lead.",
        'owner-gates': `Silence is consent only within the sender's authority, never for owner gates: ${list(config.ownerGates)} [ownerGates].` +
            " An owner's order, relayed or not, approves its work and proof unless only the owner sees the result; ask again only if it must change or needs something new.",
        deploy: "Deploy ASAP: once a change can be verified (tests, then a check it runs). State each fix's evidence and when it will exist; build nothing on it before then." +
            heavySteps(config.coordinator, command, cutoffSpan),
        'lean-calls': 'Lean calls: every tool call re-reads the whole context, so batch related shell steps into one call.' +
            ` Work in your own session: ${helperDefaultClause(budget.subagentWeight)}; run helpers on your own model and effort.` +
            (budget.enabled ? ` Pace the week to ${percent(budget.targetPct)} of the weekly limit and keep ${percent(budget.reservePct)} for incidents [budget].` : ''),
        investigate: 'Investigate first: frequency × impact, the cheapest fix for the visible symptom.' +
            // An owner question names no task by its number alone (the register refuses an owner wait without its
            // decision card, register/card.ts). With tab status on, the marker line ends the turn on the decision circle
            // (tabs/status.ts); the words are shorter there so the worst-case pack still fits CORE_PACK_MAX_CHARS.
            (config.tabStatus.enabled
                ? ` Owner questions stand alone, no bare task ids: options, numbers, your pick, a \`${DECISION_MARKER}\` line; one with one right answer is yours.`
                : ' Owner questions stand alone, no bare task ids: options, numbers and a recommendation; one with a single correct answer is yours to decide.'),
        resources: 'Rising resource use (memory, CPU, storage, tokens) needs its root cause; a raised limit is only an owner-approved bridge with a dated root-cause task. Tag a stopgap with its replacement task: `stopgap T<id>`.',
        data: "A hand-run change or delete of stored data needs the owner's OK after counts or a preview. Code that writes data ships a read-only dry run (inserted, unchanged, changed counts)." +
            ' Deleting derived data needs a verified regenerate tool and a parity run explaining each differing row; archive history and audit data before any TTL.' +
            ' Never print secret values; bind local services to 127.0.0.1, never 0.0.0.0.',
        contracts: `Tell the other side before changing a contract it reads (API, table or file). The same external failure for ${config.alerts.persistentFailureHours} h must page a human [alerts.persistentFailureHours].`,
        skills: 
        // The skill limits (description words, Owner and Last verified lines, per-area count, forbidden keys) live in
        // the guide alone: lintSkills (skills/lint.ts) flags each breach in `check`, so the pack names only the pointer.
        `A procedure you investigated and will run again becomes a skill in the same turn: \`<area>-<name>/SKILL.md\`, shared ones \`${skills.sharedPrefix}-<name>\` [skills.sharedPrefix],` +
            ` within the guide's skill limits. Memory holds facts, skills how-tos, CLAUDE.md every-turn rules.`,
        commits: 'One logical change per commit (a fix with its tests, a refactor apart from what it enables, a mechanical change alone), committed as each step passes.' +
            ` Over ${config.commits.maxLines} changed non-test lines or ${config.commits.maxFiles} non-test files [commits.maxLines, commits.maxFiles], a commit needs a \`${config.commits.largeCommitTrailer}: <reason>\` line [commits.largeCommitTrailer]` +
            { off: '.', warn: '; a push to a protected branch lists those without one [commits.gate].', refuse: '; a push to a protected branch that sends one is refused [commits.gate].' }[config.commits.gate],
        push: `${pushRule(config.pushGuard, config.prompts.hookAsks)} ${refusedRouteRule(config.prompts.hookAsks)}`,
        worktrees: 'Edit in your own worktree and branch in every git repo, never a main checkout.' +
            (platform === 'win32' ? ` Remove a worktree with \`${command} worktree remove <path>\`; a plain \`git worktree remove\` empties the main node_modules.` : '') +
            " Update comments in their code's commit, deleting one you cannot make true; verify a load-bearing comment or recorded number at its source;" +
            ' fix a stale comment, doc or proven-dead code you find in its own commit and tell its area.',
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
function keptLine(conflict) {
    const rule = `rule ${ruleNumberOf(conflict.rule)}`;
    const verdict = conflict.wins === 'local' ? `wins over ${rule}` : `loses to ${rule}`;
    return `- ${clipStart(conflict.file, KEPT_PATH_MAX_CHARS)} "${clipEnd(conflict.text, KEPT_QUOTE_MAX_CHARS)}" ${verdict}`;
}
function moreLine(count, command) {
    return `- and ${count} more: \`${command} rules scan\` lists them`;
}
/**
 * The local rules the user kept although they conflict with a core rule [ruleConflicts]: those that win first, then
 * those kept as text that loses, in at most KEPT_RULES_MAX_CHARS, the rest counted as "and N more". Empty when none.
 */
export function renderKeptRules(conflicts, command) {
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
 * owner, the owner's orders it relays as tasks, plans read from the register, never from memory, the approval waits
 * it answers, a team rule proven wrong that it fixes itself while a loosening stays the owner's, and the hire flags
 * (src/hiring/scale-out.ts, src/hiring/due.ts) it clears: when an area gets a hire, and when the hire goes.
 */
export function renderLeadRules(config, command) {
    return [
        'As the lead, also:',
        '- Bring the owner only verified results, your decisions, investigated questions and incidents.',
        `- Relay each owner order as an approved task in the same turn: \`${command} add --owner <id> --source ${config.register.ownerSource}\` [register.ownerSource].`,
        `- Plan the week from \`${command} plan\` and run \`${command} check\` at each checkpoint, never from memory.`,
        `- Answer each approval wait on you with \`${command} approve\` per the \`approvals\` skill; owner-gated content goes to the owner.`,
        '- Fix a team rule proven wrong and say so; a loosening goes to the owner.',
        "- HIRE flags: give a SCALE-OUT's slice to a hire within the owner's caps, else bring the owner a card; retire on a RETIRE-DUE.",
    ].join('\n');
}
/** The SessionStart context: the core pack, then the team's rules in full when they fit, else a pointer. */
export function renderSessionContext(core, team, command) {
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
