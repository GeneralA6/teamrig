import { migrationBackupName } from '../../config/load.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { configLockOf, issueText, openTeamKit, reloadTeamConfig, requireConfig } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/** `config validate`: every problem in the team config; exit 1 when there is any. */
export async function validate(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
    runtime.out.stdout(`NOTE config version ${load.pending.fromVersion} is older than ${load.pending.toVersion}, read as ${load.pending.toVersion} in memory; teamrig config migrate shows the rewrite`);
  }
  if (load.issues.length > 0) {
    runtime.out.stdout(`INVALID ${load.path}: ${load.issues.length} problem(s), each read as its default until fixed`);
    load.issues.forEach((issue) => runtime.out.stdout(`  ${issueText(issue)}`));
    return EXIT.failed;
  }
  runtime.out.stdout(`VALID ${load.path}`);
  return EXIT.ok;
}

/**
 * `config migrate`: shows an older config rewritten in the current format; `--yes` writes it, keeping a backup of the
 * old file. Every command already reads the old file migrated in memory, and once the new version is written a tab on
 * a teamrig before its first release refuses every write until it restarts, so the preview names that release.
 */
export async function migrate(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const { load } = kit;
  if (load.status === 'loaded' && load.newerVersion !== undefined) {
    throw new RefusedError(`${load.path} is config version ${load.newerVersion}, from a newer teamrig; update teamrig instead`);
  }
  const config = requireConfig(kit, runtime, 'read');
  if (load.status !== 'loaded' || load.pending === undefined) {
    runtime.out.stdout(`UNCHANGED ${load.path} needs no migration`);
    return EXIT.ok;
  }
  const { pending } = load;
  if (!args.switches.has('yes')) {
    runtime.out.stdout(`PREVIEW ${load.path} from version ${pending.fromVersion} to ${pending.toVersion}; nothing written`);
    pending.changes.forEach((change) => runtime.out.stdout(`  ${change}`));
    runtime.out.stdout(
      `NOTE every command reads it as version ${pending.toVersion} already; once written, a tab on a teamrig before ${pending.firstRelease} refuses every write until it restarts. Restart those tabs, then: teamrig config migrate --yes`,
    );
    return EXIT.ok;
  }
  return configLockOf(runtime, kit, config).run(async (writer) => {
    // Read again under the lock: a change written meanwhile is migrated with the rest, and a migration done meanwhile
    // is not written twice.
    const now = await reloadTeamConfig(runtime, kit);
    if (now.status !== 'loaded' || now.pending === undefined) {
      runtime.out.stdout(`UNCHANGED ${load.path} needs no migration`);
      return EXIT.ok;
    }
    const backup = await writer.write(now.pending.migrated, migrationBackupName(now.pending));
    runtime.out.stdout(`MIGRATED ${load.path} from version ${now.pending.fromVersion} to ${now.pending.toVersion}; the old file is at ${backup}`);
    now.pending.changes.forEach((change) => runtime.out.stdout(`  ${change}`));
    return EXIT.ok;
  });
}
