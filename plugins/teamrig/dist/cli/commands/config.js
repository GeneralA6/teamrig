import { writeMigration } from "../../config/load.js";
import { CONFIG_VERSION } from "../../config/types.js";
import { noPositionals } from "../args.js";
import { issueText, openTeamKit, requireConfig } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
/** `config validate`: every problem in the team config; exit 1 when there is any. */
export async function validate(args, runtime) {
    noPositionals(args);
    const { load } = await openTeamKit(runtime);
    switch (load.status) {
        case 'missing':
            throw new RefusedError(`no team config at ${load.path}`);
        case 'unreadable':
            runtime.out.stdout(`INVALID ${load.path}`);
            runtime.out.stdout(`  ${issueText(load.issue)}`);
            return EXIT.failed;
        case 'loaded':
            break;
    }
    if (load.newerVersion !== undefined) {
        runtime.out.stdout(`NOTE config version ${load.newerVersion} is from a newer teamrig: only the fields this one knows are checked`);
    }
    if (load.pending !== undefined) {
        runtime.out.stdout(`NOTE config version ${load.pending.fromVersion} is older than ${CONFIG_VERSION}; run: teamrig config migrate`);
    }
    if (load.issues.length > 0) {
        runtime.out.stdout(`INVALID ${load.path}: ${load.issues.length} problem(s), each read as its default until fixed`);
        load.issues.forEach((issue) => runtime.out.stdout(`  ${issueText(issue)}`));
        return EXIT.failed;
    }
    runtime.out.stdout(`VALID ${load.path}`);
    return EXIT.ok;
}
/** `config migrate`: rewrites an older config in the current format, keeping a backup of the old file. */
export async function migrate(args, runtime) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const { load } = kit;
    if (load.status === 'loaded' && load.newerVersion !== undefined) {
        throw new RefusedError(`${load.path} is config version ${load.newerVersion}, from a newer teamrig; update teamrig instead`);
    }
    requireConfig(kit, runtime, 'read');
    if (load.status !== 'loaded' || load.pending === undefined) {
        runtime.out.stdout(`UNCHANGED ${load.path} needs no migration`);
        return EXIT.ok;
    }
    const backup = await writeMigration(runtime.files, load.path, kit.paths.backups, load.pending, runtime.clock);
    runtime.out.stdout(`MIGRATED ${load.path} from version ${load.pending.fromVersion} to ${CONFIG_VERSION}; the old file is at ${backup}`);
    load.pending.changes.forEach((change) => runtime.out.stdout(`  ${change}`));
    return EXIT.ok;
}
