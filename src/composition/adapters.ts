/** The adapters of one side: each id beside its folder, a module specifier relative to this folder. */
export type AdapterTable = Readonly<Record<string, string>>;

/**
 * The adapters teamrig ships with. This folder is the one place that names them: the rest of teamrig reaches a
 * tool through the ports the loader hands it, so a new adapter is a folder and a row here.
 */
export const HOST_ADAPTERS: AdapterTable = {
  'claude-code': '../adapters/hosts/claude-code',
};

export const CONNECTOR_ADAPTERS: AdapterTable = {
  github: '../adapters/connectors/github',
  jira: '../adapters/connectors/jira',
  local: '../adapters/connectors/local',
};
