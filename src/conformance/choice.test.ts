import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Os, ProofRef, Support } from '../plugin-api/index.ts';
import { GREETS_KNOWN, REFUSES_UNKNOWN, WINDOWS_ONLY, greeterContract, honestGreeter } from '../testing/sample-contract.ts';
import { choiceOf, type ChoiceRequest, type ContractOutline } from './choice.ts';
import { bind, type BoundContract } from './contract.ts';

const SUPPORTED: Support = { kind: 'supported', proofs: [] };
const PARTIAL: Support = { kind: 'partial', missing: 'the prompt line', notice: 'new work shows at the next start', proofs: [] };
const UNSUPPORTED: Support = { kind: 'unsupported', notice: 'the tool has no such thing' };

function provedOn(os: Os): Support {
  const proof: ProofRef = { os, toolVersion: '1.0.0', date: '2026-11-20', evidence: 'docs/proofs/sample.md' };
  return { kind: 'supported', proofs: [proof] };
}

const ALL = { 'rules.session-start': SUPPORTED, 'inbox.prompt-line': SUPPORTED, 'os.windows-sessions': SUPPORTED };

function greeter(without?: Readonly<Record<string, string>>): BoundContract {
  return bind({ contract: greeterContract(), make: () => honestGreeter(), ...(without === undefined ? {} : { without }) });
}

function request(over: Partial<ChoiceRequest> = {}): ChoiceRequest {
  return { side: 'host', manifest: ALL, bound: [greeter()], os: 'windows', kit: [], ...over };
}

function idsOf(over: Partial<ChoiceRequest> = {}): readonly string[] {
  return choiceOf(request(over)).chosen.flatMap((each) => each.cases.map((one) => one.id));
}

describe('choiceOf', () => {
  it('runs every case of a contract whose features the manifest says are supported', () => {
    const choice = choiceOf(request());
    assert.deepEqual(
      choice.chosen.map((each) => ({ port: each.port, ids: each.cases.map((one) => one.id) })),
      [{ port: 'greeter', ids: [GREETS_KNOWN.id, REFUSES_UNKNOWN.id, WINDOWS_ONLY.id] }],
    );
    assert.deepEqual(choice.problems, []);
  });

  it('leaves a case out on an operating system it is not for', () => {
    assert.deepEqual(idsOf({ os: 'linux' }), [GREETS_KNOWN.id, REFUSES_UNKNOWN.id]);
    assert.deepEqual(idsOf({ os: 'macos' }), [GREETS_KNOWN.id, REFUSES_UNKNOWN.id]);
  });

  it('runs no case of a feature the manifest says is unsupported, and still the case another feature claims', () => {
    const manifest = { ...ALL, 'rules.session-start': UNSUPPORTED };
    assert.deepEqual(idsOf({ manifest }), [REFUSES_UNKNOWN.id, WINDOWS_ONLY.id]);
    assert.deepEqual(idsOf({ manifest: { ...manifest, 'inbox.prompt-line': UNSUPPORTED } }), [WINDOWS_ONLY.id]);
    assert.deepEqual(choiceOf(request({ manifest })).problems, []);
  });

  it('lets a partial feature leave a case out with its reason', () => {
    const manifest = { ...ALL, 'os.windows-sessions': PARTIAL };
    const bound = [greeter({ [WINDOWS_ONLY.id]: 'drive letters wait for the Windows proof' })];
    assert.deepEqual(idsOf({ manifest, bound }), [GREETS_KNOWN.id, REFUSES_UNKNOWN.id]);
    assert.deepEqual(choiceOf(request({ manifest, bound })).problems, []);
  });

  it('runs every case of a partial feature that leaves none out', () => {
    assert.deepEqual(idsOf({ manifest: { ...ALL, 'os.windows-sessions': PARTIAL } }), [GREETS_KNOWN.id, REFUSES_UNKNOWN.id, WINDOWS_ONLY.id]);
  });

  it('refuses a case left out while one of its features is supported', () => {
    const manifest = { ...ALL, 'rules.session-start': PARTIAL };
    const bound = [greeter({ [REFUSES_UNKNOWN.id]: 'not yet' })];
    assert.deepEqual(choiceOf(request({ manifest, bound })).problems, [`${REFUSES_UNKNOWN.id} cannot be left out: the manifest says inbox.prompt-line is supported`]);
  });

  it('refuses a left-out case the contract does not have, and one with no reason', () => {
    const manifest = { ...ALL, 'os.windows-sessions': PARTIAL };
    const bound = [greeter({ 'greeter.gone': 'renamed', [WINDOWS_ONLY.id]: ' ' })];
    assert.deepEqual(choiceOf(request({ manifest, bound })).problems, ['greeter leaves out greeter.gone, which is no case of it', `${WINDOWS_ONLY.id} is left out with no reason`]);
  });

  it('refuses a case naming a feature the manifest has no row for', () => {
    const manifest = { 'rules.session-start': SUPPORTED, 'os.windows-sessions': SUPPORTED };
    assert.deepEqual(choiceOf(request({ manifest })).problems, [`${REFUSES_UNKNOWN.id} names inbox.prompt-line, which the manifest has no row for`]);
  });

  it('refuses a contract of the other side, and one bound twice', () => {
    assert.deepEqual(choiceOf(request({ side: 'connector' })).problems, ['greeter is a host contract, bound by a connector adapter']);
    assert.deepEqual(choiceOf(request({ bound: [greeter(), greeter()] })).problems, ['greeter is bound twice']);
  });

  it('refuses a claimed feature whose contract of the kit is not bound, for a contract of its own side only', () => {
    const kit: readonly ContractOutline[] = [
      { port: 'greeter', side: 'host', features: ['rules.session-start', 'os.windows-sessions'] },
      { port: 'tracker', side: 'connector', features: ['rules.session-start'] },
    ];
    const manifest = { ...ALL, 'os.windows-sessions': PARTIAL };
    assert.deepEqual(choiceOf(request({ manifest, bound: [], kit })).problems, [
      'the manifest says rules.session-start is supported, and its contract greeter is not bound',
      'the manifest says os.windows-sessions is partial, and its contract greeter is not bound',
    ]);
    assert.deepEqual(choiceOf(request({ manifest, kit })).problems, []);
    assert.deepEqual(choiceOf(request({ manifest: { 'rules.session-start': UNSUPPORTED, 'os.windows-sessions': UNSUPPORTED }, bound: [], kit })).problems, []);
  });

  it('refuses a supported feature proved on this operating system that no case runs for there', () => {
    const manifest = { ...ALL, 'os.windows-sessions': provedOn('linux') };
    assert.deepEqual(choiceOf(request({ manifest, os: 'linux' })).problems, ['the manifest says os.windows-sessions is supported and proved on linux, and no case of it runs there']);
    assert.deepEqual(choiceOf(request({ manifest, os: 'macos' })).problems, []);
    assert.deepEqual(choiceOf(request({ manifest: { ...ALL, 'os.windows-sessions': provedOn('windows') }, os: 'windows' })).problems, []);
  });
});
