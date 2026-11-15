/**
 * A secret a call would print into the conversation, one its command line holds as text (`literal`), or one the text a
 * file-writing call writes holds (`written`); the last two by their shape, never their value. A `credential` is a key
 * the line reads out of the host's credential store, printed or not, by the command, API or credential name it uses.
 */
export type SecretFinding =
  | { readonly kind: 'credential'; readonly via: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'environment' }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'kube-secret' }
  | { readonly kind: 'command'; readonly program: string }
  | { readonly kind: 'literal'; readonly id: string; readonly description: string }
  | { readonly kind: 'written'; readonly id: string; readonly description: string };

/** What the call would print, or the shape of the secret its line or its written text holds, as the refusal names it. */
export function describeFinding(finding: SecretFinding): string {
  switch (finding.kind) {
    case 'literal':
    case 'written':
      return finding.description;
    case 'credential':
      return finding.via;
    case 'file':
      return `the content of ${finding.path}`;
    case 'environment':
      return 'the whole environment';
    case 'variable':
      return `the value of $${finding.name}`;
    case 'kube-secret':
      return "a Kubernetes secret's data";
    case 'command':
      return `the secrets in this ${finding.program} command's output`;
  }
}

/** `findings` without repeats, in order. */
export function uniqueFindings(findings: readonly SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = describeFinding(finding);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
