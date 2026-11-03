import { readSessionLists } from "../doctor/session-lists.js";
import { scanRules } from "../rules/scan.js";
import { readSessionContext } from "./scan-context.js";
import { findDuplicates } from "./scan-duplicates.js";
import { scanPluginHooks } from "./scan-plugin-hooks.js";
import { scanSettings } from "./scan-settings.js";
import { readTranscriptUse } from "./scan-usage.js";
async function changedSince(files, listed, since) {
    const changed = await Promise.all(listed.map(async (entry) => ({ path: entry.path, at: await files.modifiedAt(entry.path) })));
    return new Set(changed.filter(({ at }) => at !== undefined && at >= since).map(({ path }) => path));
}
function folderListing(entries) {
    return { count: entries.length, chars: entries.reduce((sum, entry) => sum + entry.line.length, 0), sources: undefined };
}
/** The `kind` listing as `recorded` holds it, else summed from the `entries` the folders list. */
function listingOf(recorded, kind, entries) {
    const list = recorded?.lists.find((one) => one.kind === kind);
    return list === undefined || list.count === 0 ? folderListing(entries) : { count: list.count, chars: list.chars, sources: list.sources };
}
/**
 * What the user's Claude Code setup costs every turn in `at.project`, and what to slim: the files and the skill and
 * agent type listings each session loads, the lines they repeat, the rule lines that may override a core rule, the
 * settings findings, where each skill and agent type was used since `at.since` (or, past `at.maxBytes` of transcripts,
 * in the newest ones read), and which of them changed since the read window starts, with Claude Code's
 * `/skill-doctor` run beside the transcript read.
 * It only reads.
 */
export async function scanSetup(ports, at) {
    const context = await readSessionContext(ports.files, ports.probe, at);
    const rules = await scanRules(ports.files, ports.probe, at, at.conflicts);
    const [usage, doctor] = await Promise.all([
        readTranscriptUse(ports.transcripts, at.projectsDir, { since: at.since, maxBytes: at.maxBytes }),
        ports.doctor.read(at.project),
    ]);
    const recorded = await readSessionLists(ports.transcripts, at.projectsDir, at.project);
    return {
        context,
        listing: listingOf(recorded, 'skills', context.skills),
        agentListing: listingOf(recorded, 'agents', context.agents),
        duplicates: findDuplicates(context.files),
        overrides: rules.candidates.filter((candidate) => !at.cleared(candidate)),
        recorded: rules.recorded.length,
        settings: [...(await scanSettings(ports.files, at.claudeDir, at.settings, at.keep, at.secrets, usage.hooks)), ...(await scanPluginHooks(ports.files, at, usage.hooks, at.secrets))],
        usage,
        recent: await changedSince(ports.files, [...context.skills, ...context.agents], usage.since),
        doctor,
    };
}
