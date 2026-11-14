import { queueCutoffSpan } from "../delivery/schedule.js";
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
 * Moved up from 7,225 for rule 11's hand-step sentence (T2309), which takes over a team rules file's stopgap line, and
 * as the worst case now counts the security reviewer, whom it had left unset.
 */
export const CORE_PACK_MAX_CHARS = 7_645;
/** The kept local rules the core pack lists [ruleConflicts] fit in this many characters (see `renderKeptRules`). */
export const KEPT_RULES_MAX_CHARS = 420;
/**
 * The team rules files a session is shown in full, its own and those of the teams above it, share this size; one that
 * does not fit gets a pointer. Down from 2,750 as rules moved into the core pack (CORE_PACK_MAX_CHARS).
 */
export const TEAM_RULES_MAX_CHARS = 2_330;
/** Claude Code caps a SessionStart hook's `additionalContext` at this size. */
export const CONTEXT_MAX_CHARS = 10_000;
/**
 * The lead's own lines fit in this many characters with worst-case config values (a CI test holds it). They come on
 * top of the core pack for the lead alone, so a team rules file near its limit may reach the lead as a pointer.
 * Raised from 810 for the owner's rule-fix lines (T1279): a peer's ask is no proof, and the fix rides each session's
 * next line. Raised from 850 for the owner's shippable-slice line (T2201), whose worst case prints a 32-character
 * class name and a two-digit cap. Raised from 1,150 for its cap per session (T2215), which names the one more a
 * session may open while one waits, from 1,215 for the owner decisions that hold a new slice, and from 1,305 for the
 * week split a team on the budget prints (T2215), whose worst case names a 32-character main lead team and a 50% floor,
 * and from 1,690 for the appeal line every lead prints (T2215).
 */
export const LEAD_RULES_MAX_CHARS = 1_900;
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
    // Under `lead` and `gated` the guard's refusal names the session's direct leader to ask (src/hooks/push-guard.ts,
    // T781), and under `gated` merge's hold says which gates a change missed (src/merge/gated-step.ts), so the rule stays
    // short.
    switch (pushGuard.pushToProtected) {
        case 'gated':
            return `Pushes to ${branches} use teamrig merge; force-pushing or deleting them is refused ${keys}.`;
        case 'lead':
            return `Pushes to ${branches} ask your leader; force-pushing or deleting them is refused ${keys}.`;
        case 'allow':
            return `Pushes to ${branches} go unasked; force-pushing or deleting them is refused ${keys}.`;
        case 'ask':
            return hookAsks === 'refuse'
                ? `Every push to ${branches} is refused [pushGuard, prompts.hookAsks].`
                : `Pushes to ${branches} ask the human; force-pushing or deleting them is refused ${keys}.`;
    }
}
/**
 * What a session does with a refused or blocked route. With hook asks off nobody answers a prompt, so the route waits
 * for the owner, as each refusal's own reason says (hooks/permission.ts), instead of waking the lead.
 */
function refusedRouteRule(hookAsks) {
    return hookAsks === 'refuse'
        ? 'A refused or blocked route waits on approval:owner; take your next task, never route around it or hand it off.'
        : 'A route refused, blocked or prompting unexpectedly goes to the lead, never routed around or handed off.';
}
/** At most two decimals, so float noise (0.30000000000000004) or a tiny value (1e-7) prints short. */
function percent(value) {
    return `${Math.round(value * 100) / 100}%`;
}
/** A clause written to follow a colon, opening its own sentence. */
function sentenceCase(clause) {
    return clause.charAt(0).toUpperCase() + clause.slice(1);
}
/**
 * The note (only what changed), evidence, skill and follow-ups a status change needs, as the register enforces them.
 * One `[register]` names the keys behind them and behind the description `add` demands, so each costs no bracket of
 * its own in the size-capped pack.
 */
function statusDemands(config, command) {
    const { register } = config;
    // Both done demands share one "on done" to save pack room.
    const onDone = [register.requireEvidenceOnDone ? 'evidence' : '', register.requireSkillOnDone ? '--skill <name>|none' : ''].filter((demand) => demand !== '');
    const demands = [
        register.requireNoteOn.length === 0 ? '' : `a note (only what changed) on ${[...new Set(register.requireNoteOn)].join(', ')}`,
        onDone.length === 0 ? '' : `${onDone.join(' and ')} on done`,
        register.requireFollowupsOn.length === 0 ? '' : `--followups <tasks it leaves>|none on ${[...new Set(register.requireFollowupsOn)].join(', ')}`,
    ].filter((demand) => demand !== '');
    const key = register.requireDescription || demands.length > 0 ? ' [register]' : '';
    return `only the owning session sets its status (\`${command} set\`)${demands.length === 0 ? '' : `, with ${demands.join(', ')}`}${key}.`;
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
    return ` Write times on the team's clock, zone-marked (\`04:00 ${label}\`, ${zone.utcOffset(now)} now); UTC only when it is the subject [timeZone].`;
}
/**
 * Rule 11's hand-step sentence (T2309). A lead handed the owner a PowerShell paste that loosened a guard before anyone
 * reviewed it, and the owner had to ask whether security had (owner order 11-09). A step the human runs by hand is
 * code no guard sees run, so it goes as a file the security reviewer read, pinned by its sha256 so the file run is the
 * file read; a team with no reviewer still has a second session read it, never its author alone. Rule 1 names the
 * reviewer and its key, so the name prints once.
 */
function handStepClause(reviewer) {
    const auditor = reviewer === undefined ? 'another session' : 'the security reviewer';
    return (' A hand step for the human that changes anything or touches a secret (a paste, a settings, config or guard line, a grant, a key)' +
        ` goes only as a file ${auditor} audited, its sha256 on the task, run by one line, never as code in chat; an edit needs a new audit.`);
}
/**
 * Rule 7's queued-step sentence, `cutoff` the span no queued step starts in, on the team's clock. A team that names a
 * repository in [delivery.repos] merges and runs its changes through it, so it gets the commands
 * too; a cutoff alone gets only its own sentence.
 */
function queuedSteps(delivery, command, cutoff) {
    const repos = Object.values(delivery.repos);
    if (repos.length === 0) {
        return cutoff === undefined ? '' : ` No queued step (builds, test runs, data scripts) starts ${cutoff} [delivery.schedule.queueCutoffUtc].`;
    }
    const deploy = repos.some((repo) => repo.deploy !== undefined) ? `, run it with \`${command} deploy\`` : '';
    return (` Run builds, test runs and data scripts through \`${command} queue\`, tests inside \`${command} test\`` +
        (cutoff === undefined ? '' : `, none starting ${cutoff}`) +
        `. Merge a tested branch with \`${command} merge\`${deploy}.` +
        // T2301: Claude Code's low-memory stop notice tells a session to get a human's OK before it re-runs what was
        // stopped, and sessions carded the owner for merges the queue would have run. Queued steps, merges and deploys
        // each wait for free memory and the host lock themselves (delivery/memory-gate.ts), so the human's OK adds
        // nothing; a leader's approval and the owner gates (rule 6) still hold.
        " Run each in the background with no human's OK, re-runs too: they wait for memory." +
        // Never `queue -- git commit`: a repository's hooks take the lock themselves, and Claude Code's worktree guard
        // refuses that form in a worktree session (the guide's `teamrig queue` section).
        ' A commit stays a plain `git commit` [delivery].');
}
/** What a message or an urgent inbox line says, in rule 3's order. */
const REPORT_PARTS = 'what happened, evidence (numbers, ids, paths), the exact ask and deadline, your default, then "No reply needed" or "Reply needed: <one question>"';
/**
 * Rule 3's sending rule. With wakes on, `inbox add --wake now` (T1147) reaches a receiver idle, busy (at its next
 * tool end) or closed (the idle pass reopens it), so urgent work is a waking inbox line and a direct message is kept
 * for a live back-and-forth. With wakes off, a line wakes no one, so a message stays the way to reach a peer now. The
 * wake-on words are cut to fit: the worst-case pack sits near CORE_PACK_MAX_CHARS.
 */
function messagesRule(config, command) {
    const lines = `${config.messages.maxLines} lines [messages.maxLines]`;
    if (!config.wake.enabled) {
        return ('A message wakes its receiver, so send one only for a result it acts on now, a decision, a blocker, a same-area conflict or an incident.' +
            ` At most ${lines}: ${REPORT_PARTS}.` +
            ` No acks, thanks or progress pings. Anything else, a "done" report too, is one inbox line per receiver: \`${command} inbox add --to <area> --text "..."\`.`);
    }
    return (`Wake a peer only for a result it acts on now, a decision, a blocker, a same-area conflict or an incident: \`${command} inbox add --to <id> --text "..." --wake now\`;` +
        ` SendMessage (at most ${lines}) only for live back-and-forth. Say ${REPORT_PARTS}.` +
        ' No acks, thanks or progress pings; drop --wake for the rest, a "done" report too.');
}
/**
 * Each core rule's text, filled from the team's config. Each rule names the config key
 * behind any value it prints, so a team changes a number without forking the text. A step only one
 * platform needs, like removing a worktree without following its node_modules junction on Windows, prints on that platform alone.
 * The queue cutoff is named on the team's clock, for the day `clock.now` falls on.
 */
export function coreRuleTexts(config, command, platform, clock) {
    const { roles, skills, budget } = config;
    const cutoff = queueCutoffSpan(clock.now.getTime(), config.delivery.schedule.queueCutoffUtc);
    const zone = TimeZone.resolve(config.timeZone, clock.machineZone);
    const cutoffSpan = cutoff === undefined ? undefined : zone.clockSpan(new Date(cutoff.from), new Date(cutoff.to));
    return {
        roles: `Roles, by session id: ${roles.lead} is the lead: priorities, team rules and the owner's decision queue [roles.lead].` +
            (roles.deliveryOwner === undefined ? '' : ` ${roles.deliveryOwner} owns the delivery flow and fleet health [roles.deliveryOwner].`) +
            (roles.securityReviewer === undefined ? '' : ` ${roles.securityReviewer} reviews privileged commands (\`${command} exec\`) and hand steps [roles.securityReviewer].`) +
            // The lead tree (config/lead-tree.ts, T781): a member's waits, approvals and pushes go to its leaders, nearest
            // first, and a leader sets the work order of the sessions under it (T782) and lifts their budgets, a sub-lead's
            // within the group share its own leader gives it (T784). No member list prints here: `leads` has no size limit,
            // so the pack names the key alone.
            ' Other sessions own their areas. Your leader (the sub-lead listing you [leads], else the lead) sets your work order, staffing and budget, answers your waits;' +
            " asks to a sub-lead's sessions go through it. Cross-area issues go to the nearest leader over both, unowned warnings to the lead.",
        'own-change': "Own your change end to end: only the session that made it merges, deploys (if it must run), verifies and fixes or rolls it back; another session's change goes to its owner.",
        messages: messagesRule(config, command) + timesClause(zone, clock.now),
        register: `Status is pulled from the register, never asked. Start each work block with \`${command} start --session <you>\`.` +
            ` Every ask that creates work is a register entry, added in the same turn by the asker (\`${command} add --owner <session>\` tells the owner), else by the receiver, with a plain description of what and why; ${statusDemands(config, command)}` +
            ' Wait on a peer by its task.' +
            ` A shipped change is verifying until its proof exists (\`${command} verify\`).`,
        'task-order': `Work your own task list in plan order (\`${command} list --session <you>\`); self-made work is a task too, added with \`${command} add\` before you start it,` +
            ' and started only for a goal, a parent task or the week plan, never ahead of your top task that is not waiting (one-commit fixes exempt).' +
            " A loop, cron or scheduled wake-up needs the lead's OK and a written stop. If you repeat a step with no progress or drift from your task, stop and ask your leader.",
        'owner-gates': `Silence is consent only within the sender's authority, never for owner gates: ${list(config.ownerGates)} [ownerGates].` +
            " An owner's order, relayed or not, approves its work and proof unless only the owner sees the result; ask again only if it must change or needs something new.",
        deploy: "Deploy ASAP: once a change can be verified (tests, then a check it runs). State each fix's evidence and when it will exist; build nothing on it before then." +
            queuedSteps(config.delivery, command, cutoffSpan),
        'lean-calls': 'Lean calls: batch related shell steps in one call.' +
            // The clause alone keeps work in the session (a helper only for parallel work or a review), so the rule spends
            // no words on saying it; the helper launch reminder still does.
            ` ${sentenceCase(helperDefaultClause(budget.subagentWeight))}; run helpers on your model and effort.` +
            // T1457: one place for a task's files and one for a session's other notes, so no session invents its own
            // (T1454's layout). A helper is told to save its findings there in its own start line (hooks/helper-start.ts),
            // which sits outside this cap.
            ` Task files go in \`${command} files T<id>\`, other notes in \`--notes\`.` +
            // T2657: a budget hold on a review or a leader's answer stalls every session waiting on it, so
            // those answers go first past any budget, and a lead plans its cuts around them.
            (budget.enabled
                ? ` Pace the week to ${percent(budget.targetPct)} of the limit, ${percent(budget.reservePct)} kept for incidents [budget]; waited-on answers are blockers, never budget-held.`
                : ''),
        investigate: 'Investigate first: frequency × impact, the cheapest fix for the visible symptom.' +
            // Owner order 11-13 (T2607): a hand step named its files repo-relative and the owner had to ask for full paths.
            // A human reads a path from another folder, so a relative one leads nowhere; a web file is its full URL. To fit
            // CORE_PACK_MAX_CHARS, rules 4, 8, 13 and 15 took shorter words.
            ' Give humans absolute paths and full URLs.' +
            // An owner question names no task by its number alone (the register refuses an owner wait without its
            // decision card, register/card.ts). With tab status on, the marker line ends the turn on the decision circle
            // (tabs/status.ts); the words are shorter there so the worst-case pack still fits CORE_PACK_MAX_CHARS. Who
            // decides is an authority test, not a count of good answers (T1194): a question that is no owner gate and no
            // business decision is the leader's however many good answers it has, and rule 1 names staffing the leader's.
            (config.tabStatus.enabled
                ? ` Ask the owner only gates and business calls: stand alone, no bare ids; options, numbers, your pick, a \`${DECISION_MARKER}\` line.`
                : ' Ask the owner only on owner gates and business decisions: each question stands alone, no bare task ids, with options, numbers and a recommendation.'),
        resources: 'Rising resource use (memory, CPU, storage, tokens) needs its root cause; a raised limit is only an owner-approved bridge with a dated root-cause task. Tag a stopgap with its replacement: `stopgap T<id>`.',
        data: "A hand-run change or delete of stored data needs the owner's OK after counts or a preview. Code that writes data ships a read-only dry run (inserted, unchanged, changed counts)." +
            ' Deleting derived data needs a verified regenerate tool and a parity run explaining each differing row; archive history and audit data before any TTL.' +
            handStepClause(roles.securityReviewer) +
            ' Never print secrets; bind local services to 127.0.0.1, never 0.0.0.0.',
        contracts: 'Tell the other side before changing a contract it reads (API, table or file).' +
            // T1189: a route removal named the pages it would break, had no answer and shipped; its proof saw the routes
            // answer 404, which any removal does, and never opened a page that read them.
            " Breaking a caller you named waits for its answer or its leader's: silence is no consent, and the proof loads that caller." +
            ` The same external failure for ${config.alerts.persistentFailureHours} h must page a human [alerts].`,
        skills: 
        // The skill limits (description words, Owner and Last verified lines, per-area count, forbidden keys) live in
        // the guide alone: lintSkills (skills/lint.ts) flags each breach in `check`, so the pack names only the pointer.
        `A procedure you investigated and will rerun becomes a skill in the same turn: \`<area>-<name>/SKILL.md\`, shared ones \`${skills.sharedPrefix}-<name>\` [skills.sharedPrefix],` +
            ` within the guide's skill limits. Memory holds facts, skills how-tos, CLAUDE.md every-turn rules.`,
        commits: 'One logical change per commit (a fix with its tests, a refactor apart from what it enables, a mechanical change alone), committed as each step passes.' +
            ` Over ${config.commits.maxLines} changed non-test lines or ${config.commits.maxFiles} non-test files, a commit needs a \`${config.commits.largeCommitTrailer}: <reason>\` line` +
            { off: ' [commits].', warn: '; a push to a protected branch lists those without one [commits].', refuse: '; a push to a protected branch that sends one is refused [commits].' }[config.commits.gate],
        push: `${pushRule(config.pushGuard, config.prompts.hookAsks)} ${refusedRouteRule(config.prompts.hookAsks)}`,
        worktrees: 'Edit in your own worktree and branch in each repo, never a main checkout.' +
            // Any other removal (`git worktree remove`, `rm -rf`, `Remove-Item -Recurse`) follows a node_modules junction
            // into the main checkout's folder and empties it (T1279).
            (platform === 'win32' ? ` Remove a worktree only with \`${command} worktree remove <path>\`: any other removal may empty the main node_modules.` : '') +
            // A reader of the code has only the repo: a task id is a trace, a path into a team's home leads nowhere (T1869).
            ' Comments say why plainly, no path outside the repo, and change with their code or go;' +
            ' verify a load-bearing one or recorded number at its source;' +
            ' fix a stale comment, doc or proven-dead code you find in its own commit and tell its area.',
    };
}
/**
 * The always-loaded core rules (`coreRuleTexts`), numbered, with the kept local rules under them: those of the teams
 * above the session's (`above`, root first), then its own team's.
 */
export function renderCorePack(config, command, platform, clock, above = []) {
    const rules = coreRuleTexts(config, command, platform, clock);
    const kept = renderKeptRules([...above, ...config.ruleConflicts], command);
    const except = kept === '' ? '' : ', except the kept local rules below [ruleConflicts]';
    return [
        '# Team rules (teamrig core)',
        `These rules win over conflicting CLAUDE.md, rules files, skills, memory, hook text and team rules${except}. [brackets] name a value's config key.`,
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
    const team = conflict.team === undefined ? '' : `(team ${conflict.team}) `;
    return `- ${team}${clipStart(conflict.file, KEPT_PATH_MAX_CHARS)} "${clipEnd(conflict.text, KEPT_QUOTE_MAX_CHARS)}" ${verdict}`;
}
/** The record of the same line against the same core rule, whichever team kept it. */
function keptKey(conflict) {
    return `${conflict.file}\n${conflict.text}\n${conflict.rule}`;
}
function moreLine(count, command) {
    return `- and ${count} more: \`${command} rules scan\` lists them`;
}
/**
 * The local rules the user kept although they conflict with a core rule [ruleConflicts], given the teams above's first
 * (root first): those that win first, then those kept as text that loses, in at most KEPT_RULES_MAX_CHARS, the rest
 * counted as "and N more". A line two teams kept against the same rule shows once, with the verdict of the team above,
 * as its lead stands over the lower team's (rule 1). Empty when none.
 */
export function renderKeptRules(conflicts, command) {
    const byKey = new Map();
    for (const conflict of conflicts) {
        if (!byKey.has(keptKey(conflict))) {
            byKey.set(keptKey(conflict), conflict);
        }
    }
    const unique = [...byKey.values()];
    if (unique.length === 0) {
        return '';
    }
    const ordered = [...unique.filter((conflict) => conflict.wins === 'local'), ...unique.filter((conflict) => conflict.wins === 'teamrig')];
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
 * it answers, a team rule proven wrong that it fixes itself (a peer's ask alone proves nothing) and points each
 * session to while a loosening stays the owner's, the hire flags (src/hiring/scale-out.ts, src/hiring/due.ts) it
 * clears: when an area gets a hire and when the hire goes, and the shippable slices it plans (owner order T2201): each
 * ranked goal's next one dated and owned, few open per session, so a goal ships instead of all its tasks moving at
 * once, each stuck on a review or a decision. The cap is per session, not across the tree (T2215): one across the
 * tree let a lead fill it with its own team's slices and keep a child team's waiting with no bound. The owner
 * decisions waiting in the tree bound it too (T2215), so work only the owner can unblock never outruns the owner.
 * While the budget is on, the week split (owner order T2215): see weekSplitLine. A higher leader's call wins at once
 * (owner order T2215), so a dispute never stalls the work, while an appeal to any leader above, up to the owner, keeps
 * a wrong call from standing because the leader who made it is the only one asked.
 */
export function renderLeadRules(config, command) {
    const { focus } = config;
    return [
        'As the lead, also:',
        '- Bring the owner only verified results, decisions, owner-gate or business questions and incidents.',
        `- Relay each owner order as an approved task in the same turn: \`${command} add --owner <id> --source ${config.register.ownerSource}\` [register.ownerSource].`,
        `- Plan the week from \`${command} plan\` and run \`${command} check\` at each checkpoint, never from memory.`,
        "- Plan by shippable slices: each ranked goal's next one (the fewest tasks that ship something working, proven live) gets an owner, ship date and live proof;" +
            ` at most ${focus.slicesPerSession} open per session, one more only while one waits on another session or the owner;` +
            ` none needing a new owner decision opens while ${focus.maxOwnerDecisions} wait in the tree;` +
            ` other work waits (incidents and ${focus.maintenanceClass} exempt) [focus.slicesPerSession, focus.maxOwnerDecisions, focus.maintenanceClass];` +
            " answer an open slice's waits first.",
        ...(config.budget.enabled ? [weekSplitLine(config.budget)] : []),
        '- Answer approval waits on you per the `approvals` skill; owner-gated content goes to the owner.',
        "- Fix a team rule proven wrong (a peer's ask is no proof); say so in each session's next line; a loosening goes to the owner.",
        "- A higher leader's call wins: concede at once; appeal, never blocking, to any leader above the one you disagree with (the owner through the main lead): a task it owns, titled `Appeal: ...`, with evidence.",
        "- HIRE flags: give a SCALE-OUT's slice to an idle hire, else hire one; retire on a RETIRE-DUE.",
        "- Send another session's task work (research, code, checks, an answer) to it with a deadline; relay its answer.",
    ].join('\n');
}
/**
 * How the account's week is shared (owner order T2215): each lead sizes its plan before the reset; after it the main
 * lead splits the week among the account's root teams and each lead its part among its own and child teams, so no
 * team takes the week first and starves another. The floor keeps a team with planned work from a zero share when its
 * own lead also runs a team in the split. Only a team on the budget prints it: without one there is no week to split.
 * The week report and what a team past its share does are the skills' (daily-meeting, team-setup), not lines here:
 * the lead's rules and short notes are never cut, and a lead's start after a refresh already nears CONTEXT_MAX_CHARS.
 */
function weekSplitLine(budget) {
    const mainLead = budget.accountLead === undefined ? "the root team's lead" : `team ${budget.accountLead}'s lead`;
    const floor = budget.shareFloorPct > 0 ? `; a team with planned work gets at least ${budget.shareFloorPct}% of each split` : '';
    return (`- Week split: before the reset, size your plan in % of the week; after it, the main lead (${mainLead}) splits the week among the account's root teams,` +
        ` then each lead its part among its own and child teams, by what each plan ships and how its last held${floor} [budget.accountLead, budget.shareFloorPct].`);
}
/**
 * Whose rules a file holds, as its heading and pointer name it. A team above wins over the teams below it, as its
 * lead stands over theirs (rule 1).
 */
function rulesTitleOf(rules) {
    return rules.ancestor === undefined ? "Your team's rules" : `Team ${rules.ancestor}'s rules (a team above yours; they win over a lower team's)`;
}
/**
 * The team rules files that follow a start context `used` characters long, in the order given (the teams above the
 * session's, root first, then its own). Each comes in full while the files shown so far fit TEAM_RULES_MAX_CHARS and
 * the context CONTEXT_MAX_CHARS, else as a pointer saying how much room was left, so a long file further up takes no
 * room a shorter one below could use.
 */
export function teamRulesPart(files, used, command) {
    let part = '';
    let shown = 0;
    for (const rules of files) {
        const text = rules.text.trim();
        if (text === '') {
            continue;
        }
        const title = rulesTitleOf(rules);
        const heading = `\n\n# ${title}\n`;
        const before = used + part.length + heading.length;
        if (shown + text.length <= TEAM_RULES_MAX_CHARS && before + text.length <= CONTEXT_MAX_CHARS) {
            part = `${part}${heading}${text}`;
            shown += text.length;
            continue;
        }
        const room = Math.max(0, Math.min(TEAM_RULES_MAX_CHARS - shown, CONTEXT_MAX_CHARS - before));
        const pointer = `\n\n${title} are in ${rules.path} (${text.length} characters; this start has room for ${room}): read them now.`;
        if (used + part.length + pointer.length > CONTEXT_MAX_CHARS) {
            const tooLong = `\n\nYour team rules files are too long to show or point to here; run \`${command} doctor\`.`;
            return used + part.length + tooLong.length <= CONTEXT_MAX_CHARS ? `${part}${tooLong}` : part;
        }
        part = `${part}${pointer}`;
    }
    return part;
}
/** The SessionStart context: the core pack, then the team rules files that fit beside it (`teamRulesPart`). */
export function renderSessionContext(core, files, command) {
    return `${core}${teamRulesPart(files, core.length, command)}`;
}
