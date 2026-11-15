import { ENV } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { CLOSE_REASONS, hostKindOf, parseIssueTarget, targetText } from "../../issues/host.js";
import { labelIssue, labelRefusal, postRefusal, writeIssue } from "../../issues/write.js";
import { RegisterPolicy } from "../../register/policy.js";
import { onePositional, requiredFlag } from "../args.js";
import { callerOf } from "../inputs.js";
import { hostOf } from "../issue-hosts.js";
import { sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { GITHUB_OFF, githubOff } from "./issue-sync-auto.js";
import { openTeam } from "./register-team.js";
/**
 * `issue comment <owner/name#n> --body <text>` (T2660): posts one comment on an issue or pull request of the team's
 * repositories, through the host whose config list names the repository (issues/host.ts; GitHub, github.repos, is
 * the only one so far). The caller must be on the team; the body may not be empty, carry a secret shape or name a
 * task id. Exit 1 when the host failed, else 0.
 */
export async function issueComment(args, runtime) {
    const target = targetOf(args);
    return writeOn(args, runtime, { target, comment: requiredFlag(args.flags, 'body'), close: false }, '--body');
}
/**
 * `issue close <owner/name#n> [--comment <text>] [--reason completed|not-planned|duplicate] [--duplicate-of
 * <owner/name#n>]` (T2660, T2679, T2999): closes one issue or pull request of the team's repositories, first posting
 * `--comment` when given, through the same host and checks as `issue comment`; `--reason` is the one the host
 * shows. `--duplicate-of` closes it as a duplicate of another issue of the same repository, which the host links.
 * A failed comment closes nothing. Exit 1 when the host failed, else 0.
 */
export async function issueClose(args, runtime) {
    const target = targetOf(args);
    const comment = args.flags.get('comment');
    const given = closeReasonOf(args.flags.get('reason'));
    const duplicateOf = duplicateOfFlag(args.flags.get('duplicate-of'), target, given);
    const reason = duplicateOf === undefined ? given : 'duplicate';
    const write = {
        target,
        close: true,
        ...(comment === undefined ? {} : { comment }),
        ...(reason === undefined ? {} : { reason }),
        ...(duplicateOf === undefined ? {} : { duplicateOf }),
    };
    return writeOn(args, runtime, write, '--comment');
}
/**
 * `issue label <owner/name#n> [--add <label,...>] [--remove <label,...>]` (T2679): adds labels to and takes labels
 * off one issue or pull request of the team's repositories, through the same host and caller checks as `issue
 * comment`. Each label to add must already be the repository's (issues/write.ts); a label in both lists, or one no
 * host takes, is refused before anything runs. Exit 1 when the host failed, else 0.
 */
export async function issueLabel(args, runtime) {
    const target = targetOf(args);
    const add = labelsOf(args.flags.get('add'), '--add');
    const remove = labelsOf(args.flags.get('remove'), '--remove');
    if (add.length === 0 && remove.length === 0) {
        throw new RefusedError('issue label needs --add or --remove, each a comma-separated list of labels');
    }
    const both = add.find((label) => remove.includes(label));
    if (both !== undefined) {
        throw new RefusedError(`the label ${JSON.stringify(both)} is in both --add and --remove: give it in one`);
    }
    const host = await hostFor(args, runtime, target.repo, undefined);
    if (host === undefined) {
        return EXIT.ok;
    }
    return (await labelIssue(host, { target, add, remove }, (line) => runtime.out.stdout(line))) ? EXIT.ok : EXIT.failed;
}
/** The close reason `--reason` names, or undefined when it is not given; refused when it names none. */
function closeReasonOf(text) {
    if (text === undefined) {
        return undefined;
    }
    const reason = CLOSE_REASONS.find((one) => one === text);
    if (reason === undefined) {
        throw new RefusedError(`--reason takes ${CLOSE_REASONS.join(', ')}, not ${JSON.stringify(text)}`);
    }
    return reason;
}
/** The labels of a comma-separated `flag`, each trimmed and named once; refused when one is no label name. */
function labelsOf(text, flag) {
    if (text === undefined) {
        return [];
    }
    const labels = [...new Set(text.split(',').map((label) => label.trim()))];
    for (const label of labels) {
        const refused = labelRefusal(label);
        if (refused !== undefined) {
            throw new RefusedError(`${flag}: ${refused}`);
        }
    }
    return labels;
}
/**
 * The issue `--duplicate-of` names, or undefined when it is not given. Refused with a reason other than duplicate,
 * when it names no issue, the closed one itself, or one of another repository: the close's access is for its own.
 */
function duplicateOfFlag(text, target, reason) {
    if (text === undefined) {
        return undefined;
    }
    if (reason !== undefined && reason !== 'duplicate') {
        throw new RefusedError(`--duplicate-of closes as a duplicate, so it takes no --reason ${reason}`);
    }
    const original = parseIssueTarget(text);
    if (original === undefined) {
        throw new RefusedError(`--duplicate-of ${text} names no issue: give it as owner/name#number, such as acme/web#7`);
    }
    if (original.repo !== target.repo) {
        throw new RefusedError(`--duplicate-of names an issue of ${original.repo}: name one of ${target.repo}, the repository of the issue it closes`);
    }
    if (original.number === target.number) {
        throw new RefusedError(`--duplicate-of names ${targetText(target)} itself: name the issue it duplicates`);
    }
    return original;
}
/** The issue or pull request the one positional names; refused when it names none. */
function targetOf(args) {
    const text = onePositional(args, 'issue');
    const target = parseIssueTarget(text);
    if (target === undefined) {
        throw new RefusedError(`${text} names no issue or pull request: give it as owner/name#number, such as acme/web#7`);
    }
    return target;
}
/** Checks the caller, the repository and the text, then writes through the repository's host. */
async function writeOn(args, runtime, write, textFlag) {
    const host = await hostFor(args, runtime, write.target.repo, write.comment === undefined ? undefined : { flag: textFlag, text: write.comment });
    if (host === undefined) {
        return EXIT.ok;
    }
    return (await writeIssue(host, write, (line) => runtime.out.stdout(line))) ? EXIT.ok : EXIT.failed;
}
/**
 * The host of `repo` once the caller is on the team, the repository is one of the team's and the text to post (if
 * any) may be posted; undefined, after an OFF line, while GitHub is off on the machine.
 */
async function hostFor(args, runtime, repo, posted) {
    const team = await openTeam(runtime, 'read');
    const notOnTeam = new RegisterPolicy(team.config, team.above).checkCaller(sessionIdOf(team.roster, callerOf(args.flags, runtime.env)));
    if (notOnTeam !== undefined) {
        throw new RefusedError(notOnTeam);
    }
    const kind = hostKindOf(repo, team.config);
    if (kind === undefined) {
        const listed = team.config.github.repos.join(', ');
        throw new RefusedError(`${repo} is not one of the team's repositories: list it under github.repos in the team config${listed === '' ? '' : ` (now ${listed})`}`);
    }
    const scanner = new SecretScanner(team.config.register.secretPatterns);
    const refused = posted === undefined ? undefined : postRefusal(posted.flag, posted.text, scanner);
    if (refused !== undefined) {
        throw new RefusedError(refused);
    }
    if (githubOff(runtime.env)) {
        runtime.out.stdout(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; nothing was written`);
        return undefined;
    }
    return hostOf(kind, runtime, scanner);
}
