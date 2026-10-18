import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import {
  asksDecision,
  DECISION_MARKER,
  FALLBACK_TOPIC,
  firstPromptOf,
  helpersRun,
  readyWaitsOnHelpers,
  TAB_CIRCLES,
  tabChangeOf,
  tabTitle,
  TITLE_MAX_CHARS,
  titleText,
  topicOf,
  type TabChange,
} from './status.ts';

function event(name: string, fields: JsonRecord = {}): JsonRecord {
  return { hook_event_name: name, ...fields };
}

function entries(...lines: readonly object[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function typed(content: unknown, extra: JsonRecord = {}): JsonRecord {
  return { type: 'user', message: { role: 'user', content }, ...extra };
}

describe('asksDecision', () => {
  it('finds the marker at the start of any line, bare, bold or as a heading', () => {
    for (const message of [
      `${DECISION_MARKER} keep logs 30 days or 90?`,
      `Two options, a and b.\n${DECISION_MARKER} a or b?\n\nThe rest of the summary.`,
      `Two options.\r\n**${DECISION_MARKER}** a or b?`,
      `## ${DECISION_MARKER} a or b?`,
    ]) {
      assert.equal(asksDecision(message), true, message);
    }
  });

  it('ignores ordinary turn ends, the marker inside a line, quoted, listed, indented or in a code block, and other casing', () => {
    for (const message of [
      undefined,
      '',
      'Done: T4 shipped, verified on the live tab.',
      `The lead's card says ${DECISION_MARKER} a or b?`,
      `> ${DECISION_MARKER} a or b?`,
      `- ${DECISION_MARKER} a or b?`,
      `    ${DECISION_MARKER} a or b?`,
      `\`\`\`\n${DECISION_MARKER} a or b?\n\`\`\``,
      `~~~md\n${DECISION_MARKER} a or b?\n~~~`,
      'decision needed: a or b?',
      'Decision needed a or b?',
      'Reply needed: a or b?',
    ]) {
      assert.equal(asksDecision(message), false, String(message));
    }
  });

  it('reads the line after a closed code block again', () => {
    assert.equal(asksDecision(`\`\`\`\nnpm test\n\`\`\`\n${DECISION_MARKER} merge now?`), true);
  });

  it('gives the decision circle its own color, apart from every other state', () => {
    assert.equal(new Set(Object.values(TAB_CIRCLES)).size, Object.keys(TAB_CIRCLES).length);
    assert.equal(TAB_CIRCLES.decision, '🔵');
  });
});

describe('tabChangeOf', () => {
  it('maps each event the plugin wires to the state it shows', () => {
    const cases: readonly [JsonRecord, TabChange][] = [
      [event('SessionStart', { source: 'startup' }), 'ready'],
      [event('SessionStart', { source: 'resume' }), 'ready'],
      [event('SessionStart', { source: 'clear' }), 'ready'],
      [event('UserPromptSubmit', { prompt: 'fix the build' }), 'working'],
      [event('PreToolUse', { tool_name: 'AskUserQuestion' }), 'waiting'],
      [event('PreToolUse', { tool_name: 'ExitPlanMode' }), 'waiting'],
      [event('PermissionRequest'), 'waiting'],
      [event('Elicitation'), 'waiting'],
      [event('PostToolUse'), 'working'],
      [event('PostToolUseFailure'), 'working'],
      [event('ElicitationResult'), 'working'],
      [event('SubagentStart'), 'working'],
      [event('Stop'), 'ready'],
      [event('Stop', { last_assistant_message: 'Done: T4 shipped.' }), 'ready'],
      [event('Stop', { last_assistant_message: 'T4 waits on you.\n\nDecision needed: ship on Friday or Monday?' }), 'decision'],
      [event('StopFailure'), 'error'],
      [event('StopFailure', { last_assistant_message: 'Decision needed: retry?' }), 'error'],
      [event('PreCompact'), 'compacting'],
      [event('PostCompact', { trigger: 'manual' }), 'ready'],
      [event('PostCompact', { trigger: 'auto' }), 'working'],
      [event('SessionEnd'), 'reset'],
    ];
    for (const [payload, change] of cases) {
      assert.equal(tabChangeOf(payload), change, JSON.stringify(payload));
    }
  });

  it('shows a slash command as ready, since most run with no turn to end', () => {
    assert.equal(tabChangeOf(event('UserPromptSubmit', { prompt: '/reload-plugins' })), 'ready');
    assert.equal(tabChangeOf(event('UserPromptSubmit', { prompt: '/teamrig:guide how' })), 'ready');
    assert.equal(tabChangeOf(event('UserPromptSubmit', { prompt: '/ is a path' })), 'working');
  });

  it("leaves the tab alone for a compaction's start, other tools, other events and no event", () => {
    assert.equal(tabChangeOf(event('SessionStart', { source: 'compact' })), undefined);
    assert.equal(tabChangeOf(event('PreToolUse', { tool_name: 'Bash' })), undefined);
    assert.equal(tabChangeOf(event('Notification')), undefined);
    assert.equal(tabChangeOf({}), undefined);
  });
});

describe('readyWaitsOnHelpers', () => {
  it('looks for helpers at a ready past a session start only', () => {
    assert.equal(readyWaitsOnHelpers(event('Stop'), 'ready'), true);
    assert.equal(readyWaitsOnHelpers(event('PostCompact'), 'ready'), true);
    assert.equal(readyWaitsOnHelpers(event('SessionStart'), 'ready'), false);
    assert.equal(readyWaitsOnHelpers(event('PostToolUse'), 'working'), false);
  });
});

describe('helpersRun', () => {
  it('counts helpers and workflows, never background commands or monitors', () => {
    assert.equal(helpersRun(['command', 'monitor']), false);
    assert.equal(helpersRun(['command', 'helper']), true);
    assert.equal(helpersRun(['workflow']), true);
    assert.equal(helpersRun([]), false);
  });
});

describe('titleText', () => {
  it('turns control characters and runs of white space into one space', () => {
    assert.equal(titleText(' fix\u0007 the\u001b]0;x\n\tbuild\u009c '), 'fix the ]0;x build');
  });

  it('cuts a long text at its last allowed character with an ellipsis, counting characters, not UTF-16 units', () => {
    const long = 'a'.repeat(TITLE_MAX_CHARS + 5);
    assert.equal(titleText(long), `${'a'.repeat(TITLE_MAX_CHARS - 1)}…`);
    assert.equal(Array.from(titleText(long)).length, TITLE_MAX_CHARS);
    const astral = '𝄞'.repeat(TITLE_MAX_CHARS);
    assert.equal(titleText(astral), astral);
  });
});

describe('tabTitle', () => {
  it("puts the state's circle before the text", () => {
    assert.equal(tabTitle('ready', 'scout'), `${TAB_CIRCLES.ready} scout`);
    assert.equal(tabTitle('waiting', ' line\none '), `${TAB_CIRCLES.waiting} line one`);
  });

  it('gives every state its own circle', () => {
    assert.equal(new Set(Object.values(TAB_CIRCLES)).size, Object.keys(TAB_CIRCLES).length);
  });
});

describe('firstPromptOf', () => {
  it("takes the first message the user typed, past Claude Code's own and helpers' messages", () => {
    const text = entries(
      { type: 'summary', summary: 'x' },
      typed('/reload-plugins'),
      typed('<command-name>/clear</command-name>'),
      typed('Caveat: generated', { isMeta: true }),
      typed('a helper brief', { isSidechain: true }),
      typed('This session is being continued', { isCompactSummary: true }),
      typed([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      typed([{ type: 'image' }, { type: 'text', text: 'Fix the  login\npage' }]),
      typed('later prompt'),
    );
    assert.equal(firstPromptOf(text), 'Fix the login page');
  });

  it('finds none in a transcript without a typed prompt, or with damaged lines only', () => {
    assert.equal(firstPromptOf(entries(typed('/model'), { type: 'assistant', message: { content: 'hi' } })), undefined);
    assert.equal(firstPromptOf('{"type":"user","message"\n'), undefined);
  });
});

describe('topicOf', () => {
  const titled = entries({ type: 'ai-title', aiTitle: 'Fixing the build' }, { type: 'custom-title', customTitle: 'scout' });

  it("takes the payload's session title first", () => {
    assert.equal(topicOf({ session_title: ' ranger ' }, { text: titled, whole: true }), 'ranger');
  });

  it("takes the user's title before Claude Code's in the transcript", () => {
    assert.equal(topicOf({}, { text: titled, whole: true }), 'scout');
    assert.equal(topicOf({}, { text: entries({ type: 'ai-title', aiTitle: 'Fixing the build' }), whole: false }), 'Fixing the build');
  });

  it("takes the first prompt from a whole transcript only, else this event's prompt", () => {
    const prompts = entries(typed('first ask'), typed('second ask'));
    assert.equal(topicOf({ prompt: 'third ask' }, { text: prompts, whole: true }), 'first ask');
    assert.equal(topicOf({ prompt: 'third ask' }, { text: prompts, whole: false }), 'third ask');
    assert.equal(topicOf({ prompt: '/compact' }, undefined), FALLBACK_TOPIC);
  });

  it("falls back to the folder's name, by either separator, then to the fallback", () => {
    assert.equal(topicOf({ cwd: 'D:\\work\\app' }, undefined), 'app');
    assert.equal(topicOf({ cwd: '/srv/work/app/' }, undefined), 'app');
    assert.equal(topicOf({ cwd: '/' }, undefined), FALLBACK_TOPIC);
    assert.equal(topicOf({ session_title: '\u0007 ' }, undefined), FALLBACK_TOPIC);
  });
});
