import assert from 'node:assert/strict';
import { stringField, type JsonRecord, type StatusLine, type StatusLinePlan, type StatusReading } from '../../plugin-api/index.ts';
import { defineContract, type ContractCase, type Subject } from '../contract.ts';

/** What a case has the status input tell of a session: the id always, each other field only when given. */
export interface WorldStatus {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly effort?: string;
}

/**
 * What a status line sees of the host: the status input the host hands the status line's command, and the settings
 * that name that command. Both are the host's own shapes, so the world writes them and reads the command back.
 */
export interface StatusLineWorld {
  /** The host's status input of a session that tells these fields, and none of the others a case may name. */
  readonly status: (told: WorldStatus) => string;
  /** The host's settings with this command as the status line; with none given, settings that draw no status line. */
  readonly settings: (command?: string) => JsonRecord;
  /** The status line's command in the host's settings; undefined when they draw none. */
  readonly commandOf: (settings: JsonRecord) => string | undefined;
}

export type StatusLineSubject = Subject<StatusLine, StatusLineWorld>;
export type StatusLineCase = ContractCase<StatusLine, StatusLineWorld, 'host'>;

/** The launcher's path, as the core hands it on a system whose paths need no rewriting. */
const LAUNCHER = '/kit/bin/statusline.mjs';

/** A status line the person had before, a single command a pipe in front does not split. */
const THEIRS = 'node "/u/scripts/own-status.cjs"';

/** Two sessions no liar's fixed answer equals. */
const FIRST: Required<WorldStatus> = { sessionId: 'session-7', cwd: '/work/repo', model: 'Model Seven', effort: 'high' };
const SECOND: Required<WorldStatus> = { sessionId: 'session-8', cwd: '/work/other', model: 'Model Eight', effort: 'low' };

/** The fields of a reading a case tells through the world; undefined when the port read nothing. */
function toldOf(reading: StatusReading | undefined): Pick<StatusReading, 'sessionId' | 'cwd' | 'model' | 'effort'> | undefined {
  return reading === undefined ? undefined : { sessionId: reading.sessionId, cwd: reading.cwd, model: reading.model, effort: reading.effort };
}

/** The plan of a change that must go through, with the settings it leaves: the plan's own, else the ones it was given. */
function planned(port: StatusLine, change: 'install' | 'uninstall', settings: JsonRecord): { readonly plan: StatusLinePlan; readonly left: JsonRecord } {
  const answer = port[change](settings, LAUNCHER);
  assert.ok(answer.ok, answer.ok ? '' : `${change} was refused: ${answer.problem}`);
  return { plan: answer.value, left: answer.value.settings ?? settings };
}

const CASES: readonly StatusLineCase[] = [
  {
    id: 'status-line.reads-input',
    title: "reads the session's id, folder, model and effort the status input tells",
    features: ['budget.status-line'],
    run: ({ port, world }) => {
      for (const told of [FIRST, SECOND]) {
        assert.deepEqual(toldOf(port.parse(world.status(told))), told);
      }
    },
  },
  {
    id: 'status-line.leaves-untold',
    title: 'leaves a field the status input did not tell undefined, the folder empty, never a value of its own making',
    features: ['budget.status-line'],
    run: ({ port, world }) => {
      assert.deepEqual(toldOf(port.parse(world.status({ sessionId: FIRST.sessionId }))), { sessionId: FIRST.sessionId, cwd: '', model: undefined, effort: undefined });
    },
  },
  {
    id: 'status-line.refuses-other-text',
    title: 'reads nothing from a text that is no status input',
    features: ['budget.status-line'],
    run: ({ port }) => {
      for (const text of ['', '[1]', 'not a status input']) {
        assert.equal(port.parse(text), undefined, JSON.stringify(text));
      }
    },
  },
  {
    id: 'status-line.installs-launcher',
    title: 'makes the launcher the status line where there was none, and a second install changes nothing',
    features: ['budget.status-line'],
    run: ({ port, world }) => {
      assert.notEqual(port.setting.trim(), '', 'the setting has no name');
      const first = planned(port, 'install', world.settings());
      const command = world.commandOf(first.left);
      assert.ok(command?.includes(LAUNCHER) === true, `the command after the install is ${JSON.stringify(command)}`);
      assert.deepEqual([first.plan.before, first.plan.after], [undefined, command]);
      assert.equal(planned(port, 'install', first.left).plan.settings, undefined, 'a second install plans a change');
    },
  },
  {
    id: 'status-line.keeps-theirs',
    title: 'runs the launcher in front of a status line already there, and an uninstall gives exactly that one back',
    features: ['budget.status-line'],
    run: ({ port, world }) => {
      const installed = planned(port, 'install', world.settings(THEIRS));
      const command = world.commandOf(installed.left);
      assert.ok(command?.includes(LAUNCHER) === true && command.includes(THEIRS), `the command after the install is ${JSON.stringify(command)}`);
      assert.deepEqual([installed.plan.before, installed.plan.after], [THEIRS, command]);
      const removed = planned(port, 'uninstall', installed.left);
      assert.deepEqual([world.commandOf(removed.left), removed.plan.before, removed.plan.after], [THEIRS, command, THEIRS]);
    },
  },
  {
    id: 'status-line.uninstall-leaves-none',
    title: 'takes its own status line out again, and leaves settings that never held the launcher alone',
    features: ['budget.status-line'],
    run: ({ port, world }) => {
      const installed = planned(port, 'install', world.settings());
      assert.notEqual(world.commandOf(installed.left), undefined, 'the install left no status line');
      assert.equal(world.commandOf(planned(port, 'uninstall', installed.left).left), undefined);
      for (const untouched of [world.settings(), world.settings(THEIRS)]) {
        assert.equal(planned(port, 'uninstall', untouched).plan.settings, undefined, 'an uninstall changed settings the launcher was never in');
      }
    },
  },
];

/** The liars' world: settings holding the status line's command as one field, and no status input, as they read none. */
const WORLD: StatusLineWorld = {
  status: () => '',
  settings: (command) => (command === undefined ? {} : { line: command }),
  commandOf: (settings) => stringField(settings, 'line'),
};

/** A liar that claims the port and does nothing: no text is a status input, and no plan changes anything. */
export function nothingStatusLine(): StatusLineSubject {
  const unchanged = (): { ok: true; value: StatusLinePlan } => ({ ok: true, value: { settings: undefined, before: undefined, after: undefined } });
  return { world: WORLD, port: { setting: 'line', parse: () => undefined, install: unchanged, uninstall: unchanged } };
}

/**
 * A liar that says yes to all: every text is a status input telling one fixed session, and every plan goes through
 * by writing settings with no status line in them.
 */
export function yesStatusLine(): StatusLineSubject {
  const reading: StatusReading = { sessionId: 'session', cwd: '/', agentName: 'agent', model: 'model', effort: 'max', costUsd: 1, contextUsedPct: 1, contextInputTokens: 1 };
  const emptied = (): { ok: true; value: StatusLinePlan } => ({ ok: true, value: { settings: {}, before: undefined, after: undefined } });
  return { world: WORLD, port: { setting: 'line', parse: () => reading, install: emptied, uninstall: emptied } };
}

/** What every host's status line must do with a status input and with the settings that name its command. */
export const STATUS_LINE_CONTRACT = defineContract<StatusLine, StatusLineWorld, 'host'>({
  port: 'status-line',
  side: 'host',
  cases: CASES,
  liars: [nothingStatusLine, yesStatusLine],
});
