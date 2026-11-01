import { demoted, promoted } from "../../config/lead-edits.js";
import { SecretScanner } from "../../core/secrets.js";
import { postLine } from "../../inbox/inbox.js";
import { onePositional, UsageError } from "../args.js";
import { callerOf, listOf } from "../inputs.js";
import { checkedNextConfig, configFileJson, configLockOf, openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * `promote` and `demote` (T781): a leader (the lead, or a sub-lead) makes one of the sessions it leads directly the
 * sub-lead of others it leads directly, or takes a sub-lead's group back. A sub-lead answers its members' decision and
 * approval waits, as the lead above it still may. Without --yes each only shows the change; with it, the old config is
 * kept in the backups folder, `leads` is rewritten, and the sub-lead gets one inbox line.
 */
/** The backup names of a config before `promote` or `demote` changed it. */
export const PROMOTE_BACKUP_NAME = 'config.promote';
export const DEMOTE_BACKUP_NAME = 'config.demote';
/** The file with `leads` replaced, or gone once no sub-lead is left. */
function withLeads(file, leads) {
    return Object.keys(leads).length === 0 ? Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'leads')) : { ...file, leads };
}
function promoteChange(members) {
    return {
        backupName: PROMOTE_BACKUP_NAME,
        plan: (config, caller, subLead) => promoted(config, caller, subLead, members),
        describe: (_config, next, caller, subLead) => `${subLead} leads ${(next[subLead] ?? []).join(', ')}, under ${caller}`,
        tell: (_config, next, caller, subLead) => `${caller} made you a sub-lead over ${(next[subLead] ?? []).join(', ')}: their decision and approval waits may come to you, answered with teamrig approve`,
    };
}
const DEMOTE = {
    backupName: DEMOTE_BACKUP_NAME,
    plan: (config, caller, subLead) => demoted(config, caller, subLead),
    describe: (config, _next, caller, subLead) => `${subLead} leads no one; ${(config.leads[subLead] ?? []).join(', ')} go back to ${caller}`,
    tell: (config, _next, caller, subLead) => `${caller} took back the sessions you led (${(config.leads[subLead] ?? []).join(', ')}); you lead no one now`,
};
async function changeLeads(args, runtime, verb, changeOf) {
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const roster = await rosterOf(runtime, kit, config);
    const by = sessionIdOf(roster, caller);
    const subLead = sessionIdOf(roster, onePositional(args, 'sub-lead'));
    const change = changeOf(roster);
    const { clock } = runtime;
    return configLockOf(runtime, kit, config).run(async (writer) => {
        const file = await configFileJson(runtime, kit.load.path);
        // Planned on the file as it is under the lock, so a retire that just rewrote `leads` is not undone.
        const current = checkedNextConfig(file);
        const planned = change.plan(current, by, subLead);
        if (!planned.ok) {
            throw new RefusedError(planned.problem);
        }
        const next = withLeads(file, planned.value);
        checkedNextConfig(next);
        const what = change.describe(current, planned.value, by, subLead);
        if (!args.switches.has('yes')) {
            runtime.out.stdout(`PREVIEW ${verb} ${what}; nothing written (add --yes to write)`);
            return EXIT.ok;
        }
        const backup = await writer.write(next, change.backupName);
        runtime.out.stdout(`${verb === 'promote' ? 'PROMOTED' : 'DEMOTED'} ${what}; the old config is at ${backup}`);
        const text = change.tell(current, planned.value, by, subLead);
        const { inboxes } = inboxDepsOf(runtime, kit.paths);
        const problem = await postLine(inboxes, new SecretScanner(config.register.secretPatterns), { to: subLead, from: by, text, now: new Date(clock.now()) });
        runtime.out.stderr(problem === undefined ? `NOTE ${subLead} has an inbox line: ${text}` : `WARN ${subLead} was not told: ${problem}`);
        return EXIT.ok;
    });
}
/** `promote <sub-lead> --members <a,b> [--yes]`. */
export async function promote(args, runtime) {
    const members = args.flags.get('members');
    if (members === undefined) {
        throw new UsageError('promote needs --members <a,b>: the sessions the sub-lead will lead');
    }
    return changeLeads(args, runtime, 'promote', (roster) => promoteChange(listOf('--members', members).map((member) => sessionIdOf(roster, member))));
}
/** `demote <sub-lead> [--yes]`. */
export async function demote(args, runtime) {
    return changeLeads(args, runtime, 'demote', () => DEMOTE);
}
