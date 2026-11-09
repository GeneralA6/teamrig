import { DEFAULT_COMMIT_GUARD, DEFAULT_COMMITS, DEFAULT_PUSH_GUARD } from "../config/defaults.js";
import { toolCommandReadings } from "../core/bash-tool-readings.js";
import { isRecord, recordField, stringField } from "../core/guards.js";
import { describeLargeCommits, largeCommits } from "../push-guard/commit-size.js";
import { hookSkips } from "../push-guard/hook-skips.js";
import { findGitInvocations } from "../push-guard/invocations.js";
import { decisionReason, doubtReason, finderContextOf, judgePushes, leasedReason, } from "../push-guard/push.js";
import { holdBackOutput } from "./permission.js";
/**
 * The branches to guard. A missing or unreadable config keeps the defaults, so a broken
 * config never switches the guard off; a loaded one has already replaced each bad field
 * with its default.
 */
export function protectedBranchesOf(load) {
    return load?.status === 'loaded' ? load.config.pushGuard.protectedBranches : DEFAULT_PUSH_GUARD.protectedBranches;
}
/** What a normal push to a protected branch gets, with the same fallback as the protected branches: a broken config asks. */
export function pushToProtectedOf(load) {
    return load?.status === 'loaded' ? load.config.pushGuard.pushToProtected : DEFAULT_PUSH_GUARD.pushToProtected;
}
/** The small-commits rule, with the same fallback as the protected branches. */
export function commitsOf(load) {
    return load?.status === 'loaded' ? load.config.commits : DEFAULT_COMMITS;
}
/** What a git command run without the repository's hooks gets, with the same fallback: a broken config refuses it. */
export function skipHooksOf(load) {
    return load?.status === 'loaded' ? load.config.commitGuard.skipHooks : DEFAULT_COMMIT_GUARD.skipHooks;
}
/** Why the guard stops a line that runs git without the repository's hooks, naming each skip as written. */
export function skipHooksReason(skips) {
    const named = [...new Set(skips.map((skip) => `git ${skip.subcommand} (${skip.by})`))].join(', ');
    return (`teamrig commit guard: this runs git without the repository's hooks: ${named}. The hooks are the repository's ` +
        "own checks: let them run and fix what they report; if a hook itself is broken, tell the lead. [commitGuard.skipHooks]");
}
/** The large commits the updates would send, each once. A range git cannot list adds none, so a broken log never blocks a push. */
function largeCommitsIn(updates, env) {
    if (env.commits.gate === 'off') {
        return [];
    }
    const commits = new Map();
    for (const update of updates) {
        for (const commit of env.commitLog.between(update.dir, update.base, update.source) ?? []) {
            commits.set(commit.sha, commit);
        }
    }
    return largeCommits([...commits.values()], env.commits);
}
/** Ends the question about a normal push to a protected branch, naming the switch that stops it. */
export const PUSH_TO_PROTECTED_HINT = "To stop asking about normal pushes, set pushGuard.pushToProtected in the team's config.json to allow, to lead to have the lead approve them, " +
    'or to gated to let teamrig merge take the changes that hold its gates.';
/** The note shown when `pushToProtected: allow` lets a normal push to a protected branch through. */
export function allowedPushNote(protectedBranches) {
    return `teamrig did not ask about this push to a protected branch (${protectedBranches.join(', ')}): pushGuard.pushToProtected is allow.`;
}
/** The note shown when `pushToProtected: lead` or `gated` lets a normal push to a protected branch through. */
export function clearedPushNote(clearance, protectedBranches, choice) {
    const why = clearance.kind === 'lead'
        ? `the lead (${clearance.lead}) pushes unasked`
        : `${clearance.by} approved ${clearance.task}; set its next status once pushed, as the approval covers this push only`;
    return `teamrig let this push to a protected branch (${protectedBranches.join(', ')}) through: ${why} [pushGuard.pushToProtected: ${choice}].`;
}
/**
 * Why `pushToProtected: lead` or `gated` refuses a normal push to a protected branch, never asking the human: under
 * `lead`, how to ask the lead for it; under `gated`, that `teamrig merge` merges the branch instead (T858).
 */
export function unclearedPushReason(clearance, protectedBranches, choice) {
    const refused = `This push to a protected branch (${protectedBranches.join(', ')}) needs a lead's approval, not the human's: ${clearance.why}. `;
    return choice === 'gated'
        ? `${refused}Merge the branch with \`teamrig merge\` instead: a change that holds the self-merge gates merges with no approval, ` +
            "and one that misses a gate is held for a leader's, saying how to ask. [pushGuard.pushToProtected: gated]"
        : `${refused}Ask on the register: \`teamrig set <task> --status waiting --waits approval:${clearance.approver} --note "<branch, what it lands, its tests>"\`, ` +
            `take your next task, and push once ${clearance.approver} approves it (\`teamrig approve\`). [pushGuard.pushToProtected]`;
}
/** Under `pushToProtected: lead` or `gated`: the note when the push is cleared, else a refusal, whatever `hookAsks` says. */
function clearedPushOutput(clearance, listing, env, choice) {
    return clearance.kind === 'none'
        ? holdBackOutput('deny', `${unclearedPushReason(clearance, env.protectedBranches, choice)}${listing}`, env.hookAsks)
        : JSON.stringify({ systemMessage: `${clearedPushNote(clearance, env.protectedBranches, choice)}${listing}` });
}
/**
 * Why the guard stops the line. Only the question about a normal push names the switch: a leased push and a line the
 * guard cannot read still ask under every choice, since either may rewrite or delete the branch.
 */
function stopReason(verdict, decision, protectedBranches) {
    if (verdict.doubt !== undefined) {
        return doubtReason(verdict.doubt, protectedBranches);
    }
    return verdict.protectedPush === 'leased' ? leasedReason(protectedBranches) : decisionReason(decision, protectedBranches);
}
/**
 * How strict a verdict is, in the order `judgePushes` weighs one line: a refusal, then a leased push's question, then
 * any other question, then a push to a protected branch let through (under `lead` and `gated`, only once cleared).
 */
function strictness(verdict) {
    switch (verdict.decision) {
        case 'deny':
            return 4;
        case 'ask':
            return verdict.protectedPush === 'leased' ? 3 : 2;
        case 'allow':
            return verdict.protectedPush === undefined ? 0 : 1;
    }
}
/**
 * The strictest of the readings' verdicts (`toolCommandReadings` gives at least one), the command as written on a tie.
 * Each reading is judged alone, never their git commands joined: the judge follows each line's checkouts in order, so
 * another reading's checkout would move the branch a push is read against.
 */
function strictestVerdict(verdicts) {
    return verdicts.reduce((kept, verdict) => (strictness(verdict) > strictness(kept) ? verdict : kept));
}
/**
 * The PreToolUse hook's stdout for one Bash or PowerShell call: a permission decision when the
 * command pushes to a protected branch, else nothing, so the normal permission flow decides.
 * Under `pushToProtected: allow` a normal push to a protected branch gets a note (`systemMessage`)
 * instead of a question, and the normal permission flow still decides; under `lead` and `gated` it gets that note only
 * when cleared (`PushClearance`), else a refusal saying what to do instead. Under the commits gate, an
 * asked or allowed push also lists the large commits it sends (`warn`) or is refused for them
 * (`refuse`). A command the guard cannot read with confidence is asked about, with a reason that
 * says what it could not read. A line that runs git without the repository's hooks (see `hookSkips`) is refused or
 * asked about first, as `skipHooks` says; a refused push stays refused under `ask`. Under `hookAsks: refuse`
 * every such question is a refusal instead, its reason saying what to do (see `holdBack`). A Bash line on Windows is
 * judged in each reading bash may run (`toolCommandReadings`), keeping the strictest verdict and every hook skip.
 */
export async function pushGuardOutput(payload, env) {
    if (!isRecord(payload)) {
        return '';
    }
    const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
    if (command === undefined) {
        return '';
    }
    const tool = stringField(payload, 'tool_name');
    const context = {
        cwd: stringField(payload, 'cwd') ?? env.cwd,
        home: env.home,
        dialect: tool === 'PowerShell' ? 'powershell' : 'bash',
        protectedBranches: env.protectedBranches,
        pushToProtected: env.pushToProtected,
        repo: env.repo,
    };
    const readings = toolCommandReadings(tool, command, env.platform).map((text) => {
        const found = findGitInvocations(text, finderContextOf(context));
        return { found, verdict: judgePushes(found, context) };
    });
    const verdict = strictestVerdict(readings.map((reading) => reading.verdict));
    if (env.skipHooks !== 'allow') {
        const skips = readings.flatMap(({ found }) => hookSkips(found.invocations));
        if (skips.length > 0 && (env.skipHooks === 'deny' || verdict.decision !== 'deny')) {
            return holdBackOutput(env.skipHooks, skipHooksReason(skips), env.hookAsks);
        }
    }
    if (verdict.decision === 'allow' && verdict.protectedPush === undefined) {
        return '';
    }
    const large = verdict.decision === 'deny' ? [] : largeCommitsIn(verdict.updates, env);
    const listing = large.length === 0 ? '' : ` ${describeLargeCommits(large, env.commits)}`;
    if (large.length > 0 && env.commits.gate === 'refuse') {
        return holdBackOutput('deny', `This push to a protected branch (${env.protectedBranches.join(', ')}) is refused: ${describeLargeCommits(large, env.commits)}`, env.hookAsks);
    }
    if (verdict.decision === 'allow') {
        const choice = env.pushToProtected;
        return choice === 'lead' || choice === 'gated'
            ? clearedPushOutput(await env.clearance(), listing, env, choice)
            : JSON.stringify({ systemMessage: `${allowedPushNote(env.protectedBranches)}${listing}` });
    }
    const asked = verdict.decision === 'ask' && verdict.protectedPush === 'normal' && env.hookAsks === 'ask';
    const hint = asked ? ` ${PUSH_TO_PROTECTED_HINT}` : '';
    return holdBackOutput(verdict.decision, `${stopReason(verdict, verdict.decision, env.protectedBranches)}${listing}${hint}`, env.hookAsks);
}
