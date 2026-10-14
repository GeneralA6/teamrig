import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { parseConfig } from '../config/parse.ts';
import type { KitConfig } from '../config/types.ts';

/** A valid config for the team `lead`, `alpha`, `bravo`, with extra keys merged at the top level. */
export function testConfig(extra: JsonRecord = {}): KitConfig {
  const { config, issues } = parseConfig({ sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' }, ...extra });
  assert.deepEqual(issues, [], 'test config must be valid');
  return config;
}
