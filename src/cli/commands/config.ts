import { extname, join } from 'node:path';
import { migrationBackupName } from '../../config/load.ts';
import { rowsUnder, settingRows, type SettingRow } from '../../config/settings.ts';
import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { clientRootOf } from '../../exec/client-integrity.ts';
import { noPositionals, UsageError, type ParsedArgs } from '../args.ts';
import { configLockOf, issueText, openTeamKit, reloadTeamConfig, requireConfig } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * The config schema beside this CLI: the plugin's own copy for the installed CLI (`<plugin>/dist/cli/main.js`), the
 * repository's for one run from source (`<repo>/src/cli/main.ts`).
 */
export function configSchemaPathOf(script: string): string {
  const root = clientRootOf(script);
  return extname(script) === '.ts' ? join(root, 'plugins', 'teamrig', 'config.schema.json') : join(root, 'config.schema.json');
}

/**
 * `config get [<key>] [--json]`: every key of the team config the schema describes, or those at and under `<key>`,
 * with its value, its default and whether `config set` may change it; `--json` for a settings screen.
 */
export async function get(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [key, extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const { load } = await openTeamKit(runtime);
  if (load.status === 'missing') {
    throw new RefusedError(`no team config at ${load.path}`);
  }
  if (load.status === 'unreadable') {
    throw new RefusedError(`${load.path} cannot be read: ${issueText(load.issue)}; teamrig config validate shows it`);
  }
  const schemaPath = configSchemaPathOf(runtime.self.script);
  const schema = parsedRecord(await runtime.files.read(schemaPath));
  if (schema === undefined) {
    throw new RefusedError(`no config schema at ${schemaPath}; reinstall teamrig`);
  }
  // The file as written, so a row shows what the team set, not the parsed value; an older format is read migrated, as
  // every command reads it.
  const raw = load.pending?.migrated ?? parsedRecord(await runtime.files.read(load.path)) ?? {};
  const all = settingRows(schema, raw, load.issues);
  const rows = key === undefined ? all : rowsUnder(all, key);
  if (rows.length === 0) {
    throw new RefusedError(`the config has no key ${key ?? ''}; teamrig config get lists them`);
  }
  if (args.switches.has('json')) {
    runtime.out.stdout(JSON.stringify({ file: load.path, rows }));
    return EXIT.ok;
  }
  rows.forEach((row) => runtime.out.stdout(settingLine(row)));
  return EXIT.ok;
}

function settingLine(row: SettingRow): string {
  const value = row.value === undefined ? '(unset)' : JSON.stringify(row.value);
  const notes = [
    ...(row.isDefault || row.default === undefined ? [] : [`default ${JSON.stringify(row.default)}`]),
    ...(row.readOnly === undefined ? [] : [`read-only: ${row.readOnly}`]),
    ...(row.problem === undefined ? [] : [`problem: ${row.problem}, read as its default`]),
  ];
  return notes.length === 0 ? `${row.path} ${value}` : `${row.path} ${value}  (${notes.join('; ')})`;
}

function parsedRecord(text: string | undefined): JsonRecord | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

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
