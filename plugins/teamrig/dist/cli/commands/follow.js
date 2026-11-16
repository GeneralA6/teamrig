import { writableObject } from "../../core/jsonl.js";
import { addFollow, dropFollow, followTarget, FOLLOWS_FORMAT, formatFollows, parseFollows } from "../../github/follows.js";
import { issueRef } from "../../github/map.js";
import { noPositionals, onePositional, UsageError } from "../args.js";
import { fileLockOf } from "../file-locks.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
/**
 * `follow <owner/name#n>`, `follow --list` and `unfollow <owner/name#n>`: the issues and pull requests a session
 * follows, whose activity the automatic sync tells it as it tells a task's owner the activity of its task's item
 * (github.activity). They are kept in one team file (github/follows.ts), changed under the sync's lock.
 */
/** What a follow brings, in the line that confirms it. */
const FOLLOW_REACH = 'its new comments, reviews, CI results, labels, closes and merges reach your inbox from the next sync';
async function callerOfRun(args, runtime) {
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    return { kit, config, session: sessionIdOf(roster, callerOf(args.flags, runtime.env)) };
}
/** The ref of the item a command names, or a usage error saying how to name one. */
function refArg(args) {
    const text = onePositional(args, 'owner/name#n');
    const target = followTarget(text);
    if (target === undefined) {
        throw new UsageError(`"${text}" names no issue or pull request: give it as owner/name#n`);
    }
    return issueRef(target.repo, target.number);
}
/**
 * Changes the follows under the sync's lock, so a follow and a sync's read never cross, and writes them when `change`
 * returns new ones. A file a newer teamrig wrote is refused, never overwritten.
 */
async function changeFollows(runtime, caller, change) {
    const path = caller.kit.paths.githubFollows;
    return fileLockOf(runtime, caller.kit.paths.githubSyncLock, caller.config.lock).run(async () => {
        const text = await runtime.files.read(path);
        writableObject(path, text, FOLLOWS_FORMAT);
        const { follows, result } = change(parseFollows(text ?? ''));
        if (follows !== undefined) {
            await runtime.files.write(path, formatFollows(follows));
        }
        return result;
    });
}
export async function follow(args, runtime) {
    const caller = await callerOfRun(args, runtime);
    if (args.switches.has('list')) {
        noPositionals(args);
        const own = parseFollows((await runtime.files.read(caller.kit.paths.githubFollows)) ?? '').get(caller.session) ?? [];
        if (own.length === 0) {
            runtime.out.stdout('FOLLOWING nothing: teamrig follow <owner/name#n> follows an issue or pull request');
        }
        own.forEach((ref) => runtime.out.stdout(`FOLLOWING ${ref}`));
        return EXIT.ok;
    }
    if (args.positionals.length === 0) {
        throw new UsageError('follow needs <owner/name#n>, or --list for what you follow');
    }
    const ref = refArg(args);
    const { github } = caller.config;
    if (!github.activity) {
        throw new RefusedError('github.activity is off, so nothing followed would reach you');
    }
    if (github.followMax === 0) {
        throw new RefusedError('following is off for this team (github.followMax is 0)');
    }
    const repo = followTarget(ref)?.repo ?? '';
    if (!github.repos.includes(repo)) {
        throw new RefusedError(`${repo} is not one of github.repos, the repositories the sync reads, so it would never hear of ${ref}`);
    }
    const change = await changeFollows(runtime, caller, (follows) => {
        const made = addFollow(follows, caller.session, ref, github.followMax);
        return { follows: made.kind === 'followed' ? made.follows : undefined, result: made };
    });
    if (change.kind === 'full') {
        throw new RefusedError(`you follow ${change.max} issues and pull requests, the most github.followMax allows: unfollow one first (teamrig follow --list)`);
    }
    runtime.out.stdout(change.kind === 'already' ? `FOLLOWING ${ref} already` : `FOLLOWING ${ref}: ${FOLLOW_REACH}`);
    return EXIT.ok;
}
export async function unfollow(args, runtime) {
    const caller = await callerOfRun(args, runtime);
    const ref = refArg(args);
    const dropped = await changeFollows(runtime, caller, (follows) => {
        const left = dropFollow(follows, caller.session, ref);
        return { follows: left, result: left !== undefined };
    });
    if (!dropped) {
        throw new RefusedError(`you do not follow ${ref} (teamrig follow --list)`);
    }
    runtime.out.stdout(`UNFOLLOWED ${ref}`);
    return EXIT.ok;
}
