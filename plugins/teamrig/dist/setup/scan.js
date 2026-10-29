import { readSessionLists } from "../doctor/session-lists.js";
import { scanRules } from "../rules/scan.js";
import { readSessionContext } from "./scan-context.js";
import { findDuplicates } from "./scan-duplicates.js";
import { scanSettings } from "./scan-settings.js";
import { readSkillUse } from "./scan-usage.js";
async function recentSkills(files, skills, since) {
    const changed = await Promise.all(skills.map(async (skill) => ({ path: skill.path, at: await files.modifiedAt(skill.path) })));
    return new Set(changed.filter(({ at }) => at !== undefined && at >= since).map(({ path }) => path));
}
function folderListing(skills) {
    return { count: skills.length, chars: skills.reduce((sum, skill) => sum + skill.line.length, 0), sources: undefined };
}
async function readListing(transcripts, at, skills) {
    const recorded = await readSessionLists(transcripts, at.projectsDir, at.project);
    const list = recorded?.lists.find((one) => one.kind === 'skills');
    return list === undefined || list.count === 0 ? folderListing(skills) : { count: list.count, chars: list.chars, sources: list.sources };
}
/**
 * What the user's Claude Code setup costs every turn in `at.project`, and what to slim: the files and skill listing
 * each session loads, the lines they repeat, the rule lines that may override a core rule, the settings findings and
 * the skills no transcript used since `at.since` (or, past `at.maxBytes` of transcripts, in the newest ones read), and
 * which skills changed since the read window starts, with Claude Code's `/skill-doctor` run beside the transcript read.
 * It only reads.
 */
export async function scanSetup(ports, at) {
    const context = await readSessionContext(ports.files, ports.probe, at);
    const rules = await scanRules(ports.files, ports.probe, at, at.conflicts);
    const [usage, doctor] = await Promise.all([
        readSkillUse(ports.transcripts, at.projectsDir, { since: at.since, maxBytes: at.maxBytes }),
        ports.doctor.read(at.project),
    ]);
    return {
        context,
        listing: await readListing(ports.transcripts, at, context.skills),
        duplicates: findDuplicates(context.files),
        overrides: rules.candidates.filter((candidate) => !at.cleared(candidate)),
        recorded: rules.recorded.length,
        settings: await scanSettings(ports.files, at.claudeDir, at.settings, at.keep, at.secrets),
        usage,
        recent: await recentSkills(ports.files, context.skills, usage.since),
        doctor,
    };
}
