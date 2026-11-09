import { join } from 'node:path';
import { sessionsTitled } from "../hooks/bind.js";
import { attribute } from "./attribute.js";
import { readLines } from "./cursor.js";
import { formatRollup, rollupFileName } from "./rollup-file.js";
import { parseRollupLine, RollupFold } from "./rollup.js";
/**
 * Who the session's inbox marks claim it for: a team's mark naming a session of that team first. Marks stay in the
 * log of the team that wrote them, so a session moved to another team leaves its old days marked in the team it left;
 * such a mark goes to the one tree team holding the id now, and claims nothing when none or several do.
 */
function markClaimOf(tree, claudeSession) {
    const marks = tree.flatMap(({ team, roster, areaBySession }) => {
        const id = areaBySession.get(claudeSession);
        return id === undefined ? [] : [{ team, roster, id }];
    });
    const held = marks.find(({ roster, id }) => roster.ids.includes(id));
    if (held !== undefined) {
        return { team: held.team, id: held.id };
    }
    for (const { id } of marks) {
        const [only, ...more] = tree.filter(({ roster }) => roster.ids.includes(id));
        if (only !== undefined && more.length === 0) {
            return { team: only.team, id };
        }
    }
    return undefined;
}
/** How many sessions of the tree a title names. */
function titleClaims(tree, title) {
    return tree.reduce((claims, { team, roster }) => claims + sessionsTitled({ team, roster }, title).length, 0);
}
/**
 * The team's own sessions' transcripts: `attribute`'s rules over the whole tree. A mark in any team beats a title, and
 * a title counts only when it names one session of the tree, so a title two teams share stays outside both.
 */
export async function attributeInTree(input) {
    const member = input.tree.find(({ team }) => team === input.own);
    if (member === undefined) {
        return new Map();
    }
    const claims = new Map(input.sessions.map(({ claudeSession }) => [claudeSession, markClaimOf(input.tree, claudeSession)]));
    const areaBySession = new Map();
    for (const [claudeSession, claim] of claims) {
        if (claim?.team === input.own) {
            areaBySession.set(claudeSession, claim.id);
        }
    }
    const attribution = await attribute({
        sessions: input.sessions.filter(({ claudeSession }) => [undefined, input.own].includes(claims.get(claudeSession)?.team)),
        team: member.team,
        roster: member.roster,
        areaBySession,
        // The sessions another team of the tree claims are filtered out above, so no peer is left to skip.
        peers: [],
        titleOf: async (transcript) => {
            const title = await input.titleOf(transcript);
            return title !== undefined && titleClaims(input.tree, title) === 1 ? title : undefined;
        },
    });
    return attribution.byTeamSession;
}
/** Folds one transcript, a chunk at a time; a last line Claude Code is still writing is left for the next run. */
async function readInto(bytes, path, fold, source, chunkBytes) {
    const transcript = fold.transcript(source);
    const size = (await bytes.size(path)) ?? 0;
    let offset = 0;
    while (offset < size) {
        const batch = await readLines(bytes, path, offset, size, chunkBytes);
        for (const raw of batch.lines) {
            const line = parseRollupLine(raw);
            if (line !== undefined) {
                transcript.line(line);
            }
        }
        if (batch.end <= offset) {
            break;
        }
        offset = batch.end;
    }
    transcript.end();
}
/** The team's rows per day. Sessions and their transcripts go in sorted, as the first reader of a repeated reply takes it. */
export async function foldTeam(bytes, input) {
    const fold = new RollupFold();
    for (const [session, { main, subagents }] of [...input.byTeamSession].sort(([a], [b]) => a.localeCompare(b))) {
        const lead = session === input.lead;
        for (const path of [...main].sort()) {
            await readInto(bytes, path, fold, { session, lead, side: false }, input.chunkBytes);
        }
        for (const path of [...subagents].sort()) {
            await readInto(bytes, path, fold, { session, lead, side: true }, input.chunkBytes);
        }
    }
    return fold.rollups();
}
/** Each day of the range with any use, against its file; a day with no use has no plan and no file. */
export async function planDays(files, input) {
    const { folder, team, range, rollups } = input;
    const plans = [];
    for (const [day, rollup] of rollups) {
        if (day < range.from || day > range.to) {
            continue;
        }
        const path = join(folder, rollupFileName(day));
        const text = formatRollup({ day, team, rows: rollup.rows, tasks: rollup.tasks });
        const stored = await files.read(path);
        const outcome = stored === undefined ? 'inserted' : stored === text ? 'unchanged' : 'changed';
        plans.push({ day, path, text, outcome, rows: rollup.rows.length, tasks: rollup.tasks.length, bytes: Buffer.byteLength(text) });
    }
    return plans;
}
/** How many days of a plan came out each way. */
export function outcomeCounts(plans) {
    const count = (outcome) => plans.filter((plan) => plan.outcome === outcome).length;
    return { inserted: count('inserted'), unchanged: count('unchanged'), changed: count('changed') };
}
/**
 * Writes the plan's new days, and its changed ones only with `rewrite`: a day that reads differently can be a day whose
 * transcripts Claude Code has since pruned, and the rows on disk are then the good ones. Returns the days it wrote.
 */
export async function applyPlans(files, plans, rewrite) {
    const written = [];
    for (const plan of plans) {
        if (plan.outcome === 'inserted' || (plan.outcome === 'changed' && rewrite)) {
            await files.write(plan.path, plan.text);
            written.push(plan.day);
        }
    }
    return written;
}
