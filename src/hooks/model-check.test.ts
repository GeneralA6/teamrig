import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LaunchConfig } from '../config/types.ts';
import { modelCheckLine, payloadEffortOf, type RunningSettings } from './model-check.ts';

const LEAD: LaunchConfig = { model: 'best', effort: 'xhigh' };
const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-5-5';

function check(wanted: LaunchConfig, running: Partial<RunningSettings>): string | undefined {
  return modelCheckLine('lead', wanted, { model: undefined, effort: undefined, ...running });
}

describe('modelCheckLine', () => {
  it('stays silent when the session runs as configured', () => {
    assert.equal(check(LEAD, { model: FABLE, effort: 'xhigh' }), undefined);
    assert.equal(check(LEAD, { model: `${FABLE}[1m]` }), undefined);
    assert.equal(check({ model: 'opus' }, { model: OPUS, effort: 'low' }), undefined);
    assert.equal(check({ model: OPUS }, { model: OPUS }), undefined);
    assert.equal(check({ model: OPUS }, { model: 'us.anthropic.claude-opus-5-5-v1:0' }), undefined);
    assert.equal(check({ model: 'claude-opus-5-5-20261001' }, { model: OPUS }), undefined);
  });

  it('stays silent when Claude Code does not say, or nothing is configured', () => {
    assert.equal(check(LEAD, {}), undefined);
    assert.equal(check({}, { model: OPUS, effort: 'low' }), undefined);
    assert.equal(check(LEAD, { effort: 'auto' }), undefined);
  });

  it('never calls a model of no known family wrong, nor anything against the default', () => {
    assert.equal(check(LEAD, { model: 'my-gateway-model' }), undefined);
    assert.equal(check({ model: 'default' }, { model: OPUS }), undefined);
  });

  it('says when best runs on another model than Fable, and that Fable may be missing', () => {
    assert.equal(
      check(LEAD, { model: OPUS }),
      'MODEL lead runs model claude-opus-5-5; the team config asks for model best at xhigh effort: type /model best (if this account has no Fable, best is Opus and nothing needs changing)',
    );
  });

  it('says when the effort differs, with or without the model', () => {
    assert.equal(
      check(LEAD, { model: OPUS, effort: 'high' }),
      'MODEL lead runs model claude-opus-5-5 at high effort; the team config asks for model best at xhigh effort: type /model best and /effort xhigh (if this account has no Fable, best is Opus and nothing needs changing)',
    );
    assert.equal(check(LEAD, { effort: 'medium' }), 'MODEL lead runs at medium effort; the team config asks for model best at xhigh effort: type /effort xhigh');
    assert.equal(
      check({ model: 'opus', effort: 'max' }, { model: OPUS, effort: 'high' }),
      'MODEL lead runs model claude-opus-5-5 at high effort; the team config asks for model opus at max effort: type /effort max',
    );
  });

  it('compares a family alias by family', () => {
    assert.equal(check({ model: 'sonnet' }, { model: 'claude-sonnet-5-5' }), undefined);
    assert.equal(
      check({ model: 'opus[1m]' }, { model: 'claude-haiku-5-5' }),
      'MODEL lead runs model claude-haiku-5-5; the team config asks for model opus[1m] at the default effort: type /model opus[1m]',
    );
  });

  it('takes Opus or Sonnet for opusplan', () => {
    assert.equal(check({ model: 'opusplan' }, { model: OPUS }), undefined);
    assert.equal(check({ model: 'opusplan' }, { model: 'claude-sonnet-5-5' }), undefined);
    assert.match(check({ model: 'opusplan' }, { model: 'claude-haiku-5-5' }) ?? '', /type \/model opusplan$/);
  });

  it('says when a full id differs from the running model', () => {
    assert.equal(
      check({ model: 'claude-opus-4-6' }, { model: OPUS }),
      'MODEL lead runs model claude-opus-5-5; the team config asks for model claude-opus-4-6 at the default effort: type /model claude-opus-4-6',
    );
  });
});

describe('payloadEffortOf', () => {
  it("reads the payload's effort.level, and nothing from a payload without one", () => {
    assert.equal(payloadEffortOf({ effort: { level: 'xhigh' } }), 'xhigh');
    assert.equal(payloadEffortOf({}), undefined);
    assert.equal(payloadEffortOf({ effort: 'xhigh' }), undefined);
    assert.equal(payloadEffortOf({ effort: { level: 3 } }), undefined);
  });
});
