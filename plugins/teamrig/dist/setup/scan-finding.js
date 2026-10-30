/** Claude Code's rough rate: a token is about four characters of English. */
const CHARS_PER_TOKEN = 4;
export function tokensOf(chars) {
    return Math.ceil(chars / CHARS_PER_TOKEN);
}
