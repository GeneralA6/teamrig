/** A secret a call would print into the conversation, or one its command line holds as text (`literal`: its shape, never its value). */
export type SecretFinding =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'environment' }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'kube-secret' }
  | { readonly kind: 'literal'; readonly id: string; readonly description: string };

/** What the call would print, or the shape of the secret its line holds, as the refusal names it. */
export function describeFinding(finding: SecretFinding): string {
  switch (finding.kind) {
    case 'literal':
      return finding.description;
    case 'file':
      return `the content of ${finding.path}`;
    case 'environment':
      return 'the whole environment';
    case 'variable':
      return `the value of $${finding.name}`;
    case 'kube-secret':
      return "a Kubernetes secret's data";
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
