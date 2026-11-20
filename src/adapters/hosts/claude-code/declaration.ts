import type { HostDeclaration, Support } from '../../../plugin-api/index.ts';

/**
 * What teamrig does on Claude Code today: every feature but the two below. No row carries a proof yet: a proof is the
 * record of a live run on the operating system it names, added when that run is made, so until then the parity page
 * shows the row unproved.
 */
const SUPPORTED: Support = { kind: 'supported', proofs: [] };

/** Tuning a session's model and effort from the user's own results is designed and not built on any CLI yet. */
const TUNING: Support = { kind: 'unsupported', notice: "tuning from a user's own results is not built yet" };

/**
 * A failed turn's error is read by its Claude Code name, and three kinds have their rule: `server_error` and
 * `overloaded` are sent again with a back-off (src/restore/api-error.ts), and an expired login tells the person and
 * is sent again after a login (src/restore/login.ts). No rule reads a rate-limit hit or a context too long as a kind.
 */
const ERROR_KINDS: Support = {
  kind: 'partial',
  missing: 'a rule of its own for a rate-limit hit and for a context too long',
  notice: 'only overload, server and login errors are sent again; a turn that failed another way waits for the person or the next wake',
  proofs: [],
};

export const declaration: HostDeclaration = {
  apiVersion: '0.1.0',
  id: 'claude-code',
  name: 'Claude Code',
  manifest: {
    'rules.session-start': SUPPORTED,
    'rules.instruction-files': SUPPORTED,
    'rules.rules-folder': SUPPORTED,
    'rules.memory': SUPPORTED,
    'rules.start-size': SUPPORTED,
    'inbox.prompt-line': SUPPORTED,
    'context.compact-hold': SUPPORTED,
    'context.size': SUPPORTED,
    'context.refresh': SUPPORTED,
    'hooks.pretool-guard': SUPPORTED,
    'hooks.file-guard': SUPPORTED,
    'hooks.exec-review': SUPPORTED,
    'hooks.readonly-allow': SUPPORTED,
    'hooks.ask-refuse': SUPPORTED,
    'hooks.permission-refuse': SUPPORTED,
    'hooks.output-redact': SUPPORTED,
    'hooks.prompt-secret': SUPPORTED,
    'hooks.tool-failure': SUPPORTED,
    'permissions.deny-lines': SUPPORTED,
    'permissions.auto-mode-routes': SUPPORTED,
    'sessions.open': SUPPORTED,
    'sessions.resume': SUPPORTED,
    'sessions.identity': SUPPORTED,
    'sessions.wake': SUPPORTED,
    'sessions.turn-end': SUPPORTED,
    'sessions.process': SUPPORTED,
    'sessions.in-tab': SUPPORTED,
    'sessions.carry': SUPPORTED,
    'sessions.effort-writeback': SUPPORTED,
    'tabs.title-status': SUPPORTED,
    'tabs.waiting-state': SUPPORTED,
    'tabs.memory': SUPPORTED,
    'wake.api-retry': SUPPORTED,
    'wake.cost': SUPPORTED,
    'skills.plugin': SUPPORTED,
    'skills.team': SUPPORTED,
    'skills.session-listing': SUPPORTED,
    'helpers.start-rules': SUPPORTED,
    'helpers.agent-types': SUPPORTED,
    'plugin.hooks-file': SUPPORTED,
    'plugin.hook-trust': SUPPORTED,
    'plugin.install-update': SUPPORTED,
    'plugin.cli-on-path': SUPPORTED,
    'budget.transcripts': SUPPORTED,
    'budget.usage': SUPPORTED,
    'budget.model-share': SUPPORTED,
    'budget.week-reading': SUPPORTED,
    'budget.five-hour': SUPPORTED,
    'budget.status-line': SUPPORTED,
    'budget.helper-weight': SUPPORTED,
    'budget.pools': SUPPORTED,
    'budget.windows': SUPPORTED,
    'budget.tuning': TUNING,
    'errors.kinds': ERROR_KINDS,
    'os.windows-sessions': SUPPORTED,
    'os.windows-hooks': SUPPORTED,
    'os.linux': SUPPORTED,
  },
};
