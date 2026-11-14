import { claudeProjectsDir, projectTranscriptPath } from '../../budget/discover.ts';
import type { HiringConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import type { TeamPaths } from '../../core/home.ts';
import { PlainLogFile } from '../../core/log-file.ts';
import { lastClaudeSessionOf } from '../../inbox/marks.ts';
import { JsonlMarkLog } from '../../inbox/store.ts';
import { resumeVerdict, type ResumeVerdict } from '../../hiring/rehire.ts';
import type { RetireRecord } from '../../hiring/record.ts';
import { readContextTokens } from '../../refresh/usage.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * Measures whether rehired session `id` resumes its last Claude Code session in `project`: that session is the
 * one that last read its inbox, its transcript is `<projects>/<project slug>/<session>.jsonl`, its idle time
 * that file's last change and its size the context at its last turn. A failed measure starts it fresh, with why.
 */
export async function resumeVerdictOf(runtime: CliRuntime, paths: TeamPaths, hiring: HiringConfig, id: string, project: string): Promise<ResumeVerdict> {
  try {
    const { marks } = await new JsonlMarkLog(new PlainLogFile(runtime.files, paths.inboxMarks)).read();
    return await claudeSessionVerdict(runtime, hiring, lastClaudeSessionOf(marks, id), project);
  } catch (error) {
    return unmeasured(error);
  }
}

/** Whether Claude Code session `claudeSession` (undefined: none on record) in `project` is small and recent enough to resume. */
export async function claudeSessionVerdict(runtime: CliRuntime, hiring: HiringConfig, claudeSession: string | undefined, project: string): Promise<ResumeVerdict> {
  try {
    const last = claudeSession === undefined ? undefined : await lastSessionOf(runtime, claudeSession, project);
    return resumeVerdict({ claudeSession, changedAt: last?.changedAt, tokens: last?.tokens }, hiring, runtime.clock.now());
  } catch (error) {
    return unmeasured(error);
  }
}

function unmeasured(error: unknown): ResumeVerdict {
  return { kind: 'fresh', detail: `its last Claude Code session could not be measured: ${errorMessage(error)}` };
}

/** A Claude Code session's transcript, when it last changed and the context at its last turn. */
export interface LastSession {
  readonly transcript: string;
  /** Epoch ms; undefined when the transcript is not there. */
  readonly changedAt: number | undefined;
  /** Undefined when the transcript is not there or its last turn could not be read. */
  readonly tokens: number | undefined;
}

/** Measures Claude Code session `claudeSession` in `project`: `<projects>/<project slug>/<session>.jsonl`. It throws when a read fails. */
export function lastSessionOf(runtime: CliRuntime, claudeSession: string, project: string): Promise<LastSession> {
  return measureTranscript(runtime, projectTranscriptPath(claudeProjectsDir(runtime.env, runtime.userHome), project, claudeSession));
}

/** Measures the Claude Code transcript at `transcript`, in whatever folder it sits. It throws when a read fails. */
export async function measureTranscript(runtime: CliRuntime, transcript: string): Promise<LastSession> {
  const changedAt = await runtime.transcripts.changedAt(transcript);
  const tokens = changedAt === undefined ? undefined : await readContextTokens(runtime.files, transcript);
  return { transcript, changedAt, tokens };
}

/** How a fresh open starts: a rehired session's on the handover its retire left, when it left one; any other's plainly. */
export function freshOpenOf(from: RetireRecord | undefined): string {
  return from?.handover === undefined ? 'open it fresh' : 'open it fresh on its handover';
}
