import type { AdmissionRules, AdmissionSource } from '../delivery/admission.ts';

/** A source that gives the same `rules` at every look, for a test whose team never edits its config. */
export function fixedAdmission(rules: AdmissionRules): AdmissionSource {
  return { rules: () => Promise.resolve(rules) };
}

/** A source whose rules a test sets between looks, as a team editing its config does; it counts each read. */
export class SettableAdmission implements AdmissionSource {
  reads = 0;
  private current: AdmissionRules;

  constructor(rules: AdmissionRules) {
    this.current = rules;
  }

  set(rules: AdmissionRules): void {
    this.current = rules;
  }

  rules(): Promise<AdmissionRules> {
    this.reads += 1;
    return Promise.resolve(this.current);
  }
}
