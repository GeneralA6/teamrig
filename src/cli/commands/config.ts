import { extname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { migrationBackupName } from '../../config/load.ts';
import { settingAt, settingValueOf, withSetting } from '../../config/setting-edit.ts';
import { rowsUnder, settingRows, type SettingRow } from '../../config/settings.ts';
import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { clientRootOf } from '../../exec/client-integrity.ts';
import { noPositionals, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import {
  checkedNextConfig,
  configFileJson,
  configLockOf,
  issueText,
  leadOnly,
  openTeamKit,
  reloadTeamConfig,
  requireConfig,
  rosterOf,
  type LoadedConfig,
} from '../kit.ts';
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
  const all = await settingRowsOf(runtime, load);
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

/** The config schema beside this CLI, and every key it describes read against the team's file. */
export interface SchemaSettings {
  readonly schema: JsonRecord;
  readonly rows: readonly SettingRow[];
}

/**
 * The schema and its rows for a loaded config; undefined when the schema file is missing or holds no JSON object.
 * It names no path and refuses nothing, so a caller that must never serve a place on the disk (`teamrig read`) tells
 * the lack in its own words.
 */
export async function schemaSettingsOf(runtime: CliRuntime, load: LoadedConfig): Promise<SchemaSettings | undefined> {
  const schema = parsedRecord(await runtime.files.read(configSchemaPathOf(runtime.self.script)));
  if (schema === undefined) {
    return undefined;
  }
  // The file as written, so a row shows what the team set, not the parsed value; an older format is read migrated, as
  // every command reads it.
  const raw = load.pending?.migrated ?? parsedRecord(await runtime.files.read(load.path)) ?? {};
  return { schema, rows: settingRows(schema, raw, load.issues) };
}

/** The rows of {@link schemaSettingsOf} for `config get` and `config set`, which refuse without a schema. */
async function settingRowsOf(runtime: CliRuntime, load: LoadedConfig): Promise<readonly SettingRow[]> {
  const settings = await schemaSettingsOf(runtime, load);
  if (settings === undefined) {
    throw new RefusedError(`no config schema at ${configSchemaPathOf(runtime.self.script)}; reinstall teamrig`);
  }
  return settings.rows;
}

export const SET_BACKUP_NAME = 'config.set';

/**
 * `config set <key> <value> | <key> --unset [--yes]`, the lead only: one key `config get` marks editable, its value
 * read by the key's type; --unset removes it so it reads its default. Without --yes it shows the change. The loader
 * checks the whole new config before it is written, so a config with a problem elsewhere is refused until fixed, and a
 * set that fixes the only problem goes through; the old file is kept in the backups folder.
 */
export async function set(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [key, text, extra] = args.positionals;
  const unset = args.switches.has('unset');
  if (key === undefined) {
    throw new UsageError('config set needs <key> <value>, or <key> --unset');
  }
  if (unset && text !== undefined) {
    throw new UsageError(`--unset takes no value, not "${text}"`);
  }
  if (!unset && text === undefined) {
    throw new UsageError(`config set ${key} needs a value, or --unset to read its default`);
  }
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"; quote a value with spaces`);
  }
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { load } = kit;
  if (load.status !== 'loaded') {
    throw new RefusedError(`no team config at ${load.path}`);
  }
  if (load.newerVersion !== undefined) {
    throw new RefusedError(`${load.path} is config version ${load.newerVersion}, from a newer teamrig; update teamrig before writing`);
  }
  if (load.pending !== undefined) {
    throw new RefusedError(`${load.path} is config version ${load.pending.fromVersion}; write the current format first: teamrig config migrate`);
  }
  leadOnly(await rosterOf(runtime, kit, config), callerOf(args.flags, runtime.env), 'changes the team config');
  const row = editableRowOf(await settingRowsOf(runtime, load), key);
  const typed = text === undefined ? undefined : settingValueOf(row, text);
  if (typed !== undefined && !typed.ok) {
    throw new RefusedError(typed.problem);
  }
  const value = typed?.value;
  return configLockOf(runtime, kit, config).run(async (writer) => {
    // Read under the lock, so a change written meanwhile is kept.
    const file = await configFileJson(runtime, load.path);
    const old = settingAt(file, key);
    if (isDeepStrictEqual(old, value)) {
      runtime.out.stdout(`UNCHANGED ${key} ${shownSetting(old, row)}`);
      return EXIT.ok;
    }
    const next = withSetting(file, key, value);
    checkedNextConfig(next);
    const what = `${key} ${shownSetting(old, row)} -> ${shownSetting(value, row)}`;
    if (!args.switches.has('yes')) {
      runtime.out.stdout(`PREVIEW set ${what}; nothing written (add --yes to write)`);
      return EXIT.ok;
    }
    const backup = await writer.write(next, SET_BACKUP_NAME);
    runtime.out.stdout(`SET ${what}; the old config is at ${backup}`);
    return EXIT.ok;
  });
}

/** The row of `key` when `config set` may change it; refused for an unknown key, a group or a read-only key. */
function editableRowOf(rows: readonly SettingRow[], key: string): SettingRow {
  const row = rows.find((candidate) => candidate.path === key);
  if (row === undefined) {
    const under = rowsUnder(rows, key);
    throw new RefusedError(
      under.length === 0 ? `the config has no key ${key}; teamrig config get lists them` : `${key} holds ${under.length} keys; set one: ${under.map((one) => one.path).join(', ')}`,
    );
  }
  if (row.readOnly !== undefined) {
    throw new RefusedError(`${key} is read-only: ${row.readOnly}`);
  }
  return row;
}

function shownSetting(value: unknown, row: SettingRow): string {
  if (value !== undefined) {
    return JSON.stringify(value);
  }
  return row.default === undefined ? '(unset)' : `(unset: default ${JSON.stringify(row.default)})`;
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
