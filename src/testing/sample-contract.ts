import assert from 'node:assert/strict';
import { defineContract, type Contract, type ContractCase, type Subject } from '../conformance/contract.ts';

/** A port small enough to read in a spec: it answers a greeting for a name its world holds. */
export interface Greeter {
  readonly greet: (name: string) => string;
}

/** What a greeter sees: the names it knows, and each greeting it was asked for. */
export interface GreeterWorld {
  readonly known: readonly string[];
  readonly asked: string[];
}

export type GreeterCase = ContractCase<Greeter, GreeterWorld, 'host'>;

export const GREETS_KNOWN: GreeterCase = {
  id: 'greeter.greets-known',
  title: 'greets a name it knows',
  features: ['rules.session-start'],
  run: ({ port, world }) => {
    const name = world.known[0] ?? '';
    assert.equal(port.greet(name), `hello ${name}`);
    assert.deepEqual(world.asked, [name]);
  },
};

export const REFUSES_UNKNOWN: GreeterCase = {
  id: 'greeter.refuses-unknown',
  title: 'refuses a name it does not know',
  features: ['rules.session-start', 'inbox.prompt-line'],
  run: ({ port }) => {
    assert.throws(() => port.greet('nobody'));
  },
};

export const WINDOWS_ONLY: GreeterCase = {
  id: 'greeter.windows-drive',
  title: 'greets a drive letter on Windows',
  features: ['os.windows-sessions'],
  os: ['windows'],
  run: ({ port }) => {
    assert.equal(port.greet('C:'), 'hello C:');
  },
};

/** A greeter that does what the contract asks. */
export function honestGreeter(known: readonly string[] = ['ada', 'C:']): Subject<Greeter, GreeterWorld> {
  const world: GreeterWorld = { known, asked: [] };
  return {
    world,
    port: {
      greet: (name) => {
        if (!known.includes(name)) {
          throw new Error(`no ${name} here`);
        }
        world.asked.push(name);
        return `hello ${name}`;
      },
    },
  };
}

/** A liar that answers nothing and records nothing. */
export function silentGreeter(): Subject<Greeter, GreeterWorld> {
  return { world: { known: ['ada'], asked: [] }, port: { greet: () => '' } };
}

/** A liar that greets whoever it is asked for. */
export function eagerGreeter(): Subject<Greeter, GreeterWorld> {
  const world: GreeterWorld = { known: ['ada'], asked: [] };
  return {
    world,
    port: {
      greet: (name) => {
        world.asked.push(name);
        return `hello ${name}`;
      },
    },
  };
}

export function greeterContract(over: Partial<Contract<Greeter, GreeterWorld, 'host'>> = {}): Contract<Greeter, GreeterWorld, 'host'> {
  return defineContract({ port: 'greeter', side: 'host', cases: [GREETS_KNOWN, REFUSES_UNKNOWN, WINDOWS_ONLY], liars: [silentGreeter, eagerGreeter], ...over });
}
