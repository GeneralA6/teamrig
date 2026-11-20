import type { HostGroup } from '../feature.ts';

/** The guards and replies teamrig gives on a tool call, a prompt and a question to the person. */
export const HOOKS_FEATURES = {
  'hooks.pretool-guard': { doc: 'the push, package, database-write and directory-hop guards on shell calls', byDefault: 'on' },
  'hooks.file-guard': { doc: 'the secret, service-role and pass-record guards on reads and edits', byDefault: 'on' },
  'hooks.exec-review': { doc: 'privileged commands run on review (`teamrig exec`)', byDefault: 'on' },
  'hooks.readonly-allow': { doc: 'read-only commands run without a prompt', byDefault: 'on' },
  'hooks.ask-refuse': { doc: 'refusing a question to the person when asks are off', byDefault: 'on' },
  'hooks.permission-refuse': { doc: 'refusing a permission prompt when asks are off', byDefault: 'on' },
  'hooks.output-redact': { doc: 'redacting a secret in tool output', byDefault: 'on' },
  'hooks.prompt-secret': { doc: 'stopping a secret pasted in a prompt', byDefault: 'on' },
  'hooks.tool-failure': { doc: 'the status at a tool call end and the missing-command hint', byDefault: 'on' },
} as const satisfies HostGroup<'hooks'>;
