import { namedOnly } from '../../config/named-keys.ts';
import { servedMarkOf } from '../../config/served-mark.ts';
import { definitionsOf, settingNodes } from '../../config/settings.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { TimeZone } from '../../core/zone.ts';
import { configBody, type SettingInput } from '../../interface/index.ts';
import { loadedConfig, teamZone } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { loadTree, teamsFolderOf } from '../tree.ts';
import { configSchemaPathOf, schemaSettingsOf, type SchemaSettings } from './config.ts';
import { once, stampsOf, type DocumentSource, type ReadScope } from './read-source.ts';

/** What `config` tells when the schema beside this CLI is missing or no JSON object; the schema's place is not served. */
export const SCHEMA_PROBLEM = 'the config schema beside this teamrig cannot be read, so no setting is served; reinstall teamrig';

/**
 * `config`: the team, its zone, its priorities' names and every key of the team config the schema describes, as
 * `config get --json` reads them, for a settings screen. It reads the team's config file and the schema beside this
 * CLI, and nothing else decides it: a rush or a team above changes what a command runs with, never what the file
 * holds, and the rows are read from the file. A key that names where a secret is kept is served without its value,
 * by the schema's own mark, and a value comes less every key the schema does not name.
 */
export function configSource(scope: ReadScope): DocumentSource {
  const { runtime, kit, config } = scope;
  const zone = teamZone(config, runtime);
  return {
    async parts() {
      return {
        document: 'config',
        args: [
          ['team', kit.paths.team],
          ['zone', zone.name],
        ],
        stamps: await stampsOf(runtime, [kit.load.path, configSchemaPathOf(runtime.self.script)]),
      };
    },
    async build() {
      const read = await schemaSettingsOf(runtime, loadedConfig(kit));
      const body = configBody({
        team: kit.paths.team,
        teams: [],
        timeZone: zone.name,
        priorities: config.register.priorities.map((priority) => priority.name),
        settings: read === undefined ? [] : settingInputsOf(read),
        shapes: new SecretScanner(config.register.secretPatterns),
      });
      return { body, problems: read === undefined ? [SCHEMA_PROBLEM] : [] };
    },
  };
}

/** Each row with how its key is served, its value walked by the row's own schema node. */
function settingInputsOf({ schema, rows }: SchemaSettings): SettingInput[] {
  const nodes = settingNodes(schema);
  const definitions = definitionsOf(schema);
  return rows.map((row): SettingInput => {
    // A row always has its node, both being one walk of one schema; with none, nothing of the value is named.
    const node = nodes.get(row.path) ?? {};
    return {
      ...row,
      ...(row.value === undefined ? {} : { value: namedOnly(row.value, node, definitions) }),
      served: servedMarkOf(row.path, node),
    };
  });
}

/**
 * `config` for a run with no team: `team` null and the teams of this machine to join one of, so a setup screen
 * lists no folder itself. It reads the kit home's team folders and each one's config, as the tree does; a folder
 * whose config cannot be read is no team to join and is left out, and `sessions` is where a team tells of it.
 */
export function teamlessConfigSource(runtime: CliRuntime): DocumentSource {
  const zone = TimeZone.resolve(undefined, runtime.timeZone);
  const tree = once(() => loadTree(runtime));
  return {
    async parts() {
      const loaded = await tree();
      const configs = [...[...loaded.teams.values()].map(({ kit }) => kit.load.path), ...[...loaded.leftOut.values()].map((load) => load.path)];
      return {
        document: 'config',
        args: [
          ['team', null],
          ['zone', zone.name],
        ],
        // A team folder added or removed moves no file the tree read: the folder's own listing tells.
        stamps: [(await runtime.files.list(teamsFolderOf(runtime))).join(','), ...(await stampsOf(runtime, configs))],
      };
    },
    async build() {
      const body = configBody({
        team: null,
        teams: [...(await tree()).teams.keys()],
        timeZone: zone.name,
        priorities: [],
        settings: [],
        shapes: new SecretScanner(),
      });
      return { body, problems: [] };
    },
  };
}
