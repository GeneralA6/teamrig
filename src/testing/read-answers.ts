import assert from 'node:assert/strict';
import { isRecord, isStringArray, type JsonRecord } from '../core/guards.ts';
import { EXIT } from '../cli/runtime.ts';
import type { CliResult } from './cli-harness.ts';

/** What the specs of `teamrig read` take a run's answers apart with, one file per document sharing them. */

/** Every stdout line as the JSON object it must be: `read` writes nothing else there. */
export function answersOf(result: CliResult): JsonRecord[] {
  return result.stdout.map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
      throw new Error(`stdout holds a line that is no JSON object: ${line}`);
    }
    return parsed;
  });
}

/** The one document a run that asked for one was answered with, after a clean exit. */
export function served(result: CliResult): JsonRecord {
  assert.deepEqual([result.code, result.stderr], [EXIT.ok, []]);
  const answers = answersOf(result);
  const [answer] = answers;
  if (answer === undefined || answers.length !== 1) {
    throw new Error(`one answer was asked and ${answers.length} came`);
  }
  return answer;
}

/** The records an answer lists under `key`, such as its tasks or its meetings. */
export function rowsOf(answer: JsonRecord, key: string): JsonRecord[] {
  const rows = answer[key];
  if (!Array.isArray(rows)) {
    throw new Error(`the answer has no ${key} list`);
  }
  return rows.filter(isRecord);
}

export function problemsOf(answer: JsonRecord): readonly string[] {
  const problems = answer['problems'];
  if (!isStringArray(problems)) {
    throw new Error('the answer has no problems list');
  }
  return problems;
}
