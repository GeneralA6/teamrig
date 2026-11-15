/** What the call would print, or the shape of the secret its line or its written text holds, as the refusal names it. */
export function describeFinding(finding) {
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
export function uniqueFindings(findings) {
    const seen = new Set();
    return findings.filter((finding) => {
        const key = describeFinding(finding);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
