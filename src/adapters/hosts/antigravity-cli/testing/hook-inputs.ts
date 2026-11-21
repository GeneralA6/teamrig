/**
 * Hook inputs for the Antigravity CLI adapter's specs, written from the docs, not recorded from a run.
 *
 * Each one is written by hand from agy's hooks page (`https://antigravity.google/docs/hooks/`, read 2026-11-20 for
 * agy 1.5.12) and holds every field the page names for its event. No agy produced them: the ids, paths and texts are
 * made up, and the tool calls use the tool and argument names the page lists (`run_command`, `write_to_file`,
 * `invoke_subagent`). Inputs recorded from a live agy replace these once a host has one; until then a spec that
 * passes on them shows the code agrees with the page, not with a running agy.
 */

import type { AntigravityHookEvent } from '../events.ts';

export interface DocsBuiltHookInput {
  readonly event: AntigravityHookEvent;
  readonly input: Readonly<Record<string, unknown>>;
}

const COMMON = {
  conversationId: '6f1c2b9e-4d3a-4e7b-9a10-2c5d8e7f3b41',
  workspacePaths: ['/work/project'],
  transcriptPath: '/work/agy-home/conversations/6f1c2b9e/transcript.jsonl',
  artifactDirectoryPath: '/work/agy-home/brain/6f1c2b9e',
  modelName: 'gemini-3-pro',
} as const;

const SHELL_CALL = { name: 'run_command', args: { CommandLine: 'git status --short', Cwd: '/work/project' } } as const;

const WRITE_CALL = {
  name: 'write_to_file',
  args: { TargetFile: '/work/project/notes/todo.md', Overwrite: false, CodeContent: '- write the spec\n' },
} as const;

const HELPER_CALL = {
  name: 'invoke_subagent',
  args: { Subagents: [{ Prompt: 'List the files under src.', Role: 'explorer', TypeName: 'general', Workspace: '/work/project' }] },
} as const;

export const DOCS_BUILT_HOOK_INPUTS = {
  sessionStart: { event: 'SessionStart', input: { ...COMMON } },
  sessionStartWithPrompt: { event: 'SessionStart', input: { ...COMMON, lastUserInput: 'What is next on my list?' } },
  preToolUseShell: { event: 'PreToolUse', input: { ...COMMON, toolCall: SHELL_CALL, stepIdx: 3 } },
  preToolUseWrite: { event: 'PreToolUse', input: { ...COMMON, toolCall: WRITE_CALL, stepIdx: 5 } },
  preToolUseHelper: { event: 'PreToolUse', input: { ...COMMON, toolCall: HELPER_CALL, stepIdx: 7 } },
  postToolUseShell: { event: 'PostToolUse', input: { ...COMMON, toolCall: SHELL_CALL, stepIdx: 3, error: '' } },
  postToolUseFailed: {
    event: 'PostToolUse',
    input: { ...COMMON, toolCall: WRITE_CALL, stepIdx: 5, error: 'the file already exists' },
  },
  preInvocation: {
    event: 'PreInvocation',
    input: { ...COMMON, lastUserInput: 'What is next on my list?', invocationNum: 0, initialNumSteps: 2 },
  },
  postInvocation: { event: 'PostInvocation', input: { ...COMMON, invocationNum: 1, initialNumSteps: 2 } },
  stop: {
    event: 'Stop',
    input: { ...COMMON, executionNum: 0, terminationReason: 'model_stop', error: '', fullyIdle: true },
  },
} as const satisfies Readonly<Record<string, DocsBuiltHookInput>>;
