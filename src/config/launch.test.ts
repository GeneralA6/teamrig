import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { DEFAULT_LEAD_LAUNCH } from './defaults.ts';
import { describeLaunch, isDefaultModel, isEffort, isModel, launchOf, MODEL_ALIASES, ownLaunchOf } from './launch.ts';

describe('isModel', () => {
  it('takes every documented alias', () => {
    for (const alias of MODEL_ALIASES) {
      assert.equal(isModel(alias), undefined, alias);
    }
  });

  it('takes full model ids, with a date, a provider version or the 1M window', () => {
    for (const id of ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1@20250805', 'claude-opus-5-5[1m]', 'claude-3.7-sonnet']) {
      assert.equal(isModel(id), undefined, id);
    }
  });

  it('refuses other names, odd case, a stray window suffix and a long id', () => {
    for (const model of ['gpt-5', 'Opus', 'best[1m]', 'haiku[1m]', 'claude-', 'claude-opus 5', 'claude--opus', `claude-${'a'.repeat(100)}`]) {
      assert.match(isModel(model) ?? '', /^expected a model alias \(default, best, .*\) or a model id starting claude-$/, model);
    }
  });
});

describe('isEffort', () => {
  it('takes the five effort levels and refuses anything else', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(isEffort(level), undefined, level);
    }
    assert.equal(isEffort('auto'), 'expected one of low, medium, high, xhigh, max');
    assert.equal(isEffort('High'), 'expected one of low, medium, high, xhigh, max');
  });
});

describe('launchOf', () => {
  it('starts the lead on Opus at xhigh effort when nothing is set', () => {
    assert.deepEqual(DEFAULT_LEAD_LAUNCH, { model: 'opus', effort: 'xhigh' });
    assert.deepEqual(launchOf(testConfig(), 'lead'), { model: 'opus', effort: 'xhigh' });
  });

  it('lets the lead set each key on its own and keeps the default for the other', () => {
    assert.deepEqual(launchOf(testConfig({ launch: { lead: { model: 'best' } } }), 'lead'), { model: 'best', effort: 'xhigh' });
    assert.deepEqual(launchOf(testConfig({ launch: { lead: { effort: 'max' } } }), 'lead'), { model: 'opus', effort: 'max' });
    assert.deepEqual(launchOf(testConfig({ launch: { lead: { model: 'default', effort: 'high' } } }), 'lead'), { model: 'default', effort: 'high' });
  });

  it('leaves the other sessions to Claude Code unless they are set', () => {
    const config = testConfig({ launch: { alpha: { model: 'sonnet', effort: 'medium' } } });
    assert.deepEqual(launchOf(config, 'alpha'), { model: 'sonnet', effort: 'medium' });
    assert.deepEqual(launchOf(config, 'bravo'), {});
  });

  it('never reads an id from the object prototype', () => {
    assert.deepEqual(launchOf(testConfig(), 'constructor'), {});
  });
});

describe('ownLaunchOf', () => {
  it("is what the config itself sets for the session, without the lead's defaults (T2440)", () => {
    const config = testConfig({ launch: { lead: { effort: 'high' }, alpha: { model: 'sonnet' } } });
    assert.deepEqual(ownLaunchOf(config, 'lead'), { effort: 'high' });
    assert.deepEqual(ownLaunchOf(config, 'alpha'), { model: 'sonnet' });
    assert.deepEqual(ownLaunchOf(testConfig(), 'lead'), {});
    assert.deepEqual(ownLaunchOf(testConfig(), 'constructor'), {});
  });
});

describe('isDefaultModel', () => {
  it('is true only for no model or the default alias', () => {
    assert.equal(isDefaultModel(undefined), true);
    assert.equal(isDefaultModel('default'), true);
    assert.equal(isDefaultModel('best'), false);
  });
});

describe('describeLaunch', () => {
  it('names the model and the effort, or says each is the default', () => {
    assert.equal(describeLaunch({ model: 'best', effort: 'xhigh' }), 'model best at xhigh effort');
    assert.equal(describeLaunch({ model: 'sonnet' }), 'model sonnet at the default effort');
    assert.equal(describeLaunch({ effort: 'high' }), 'the default model at high effort');
    assert.equal(describeLaunch({ model: 'default', effort: 'low' }), 'the default model at low effort');
    assert.equal(describeLaunch({}), 'the default model and effort');
  });
});
