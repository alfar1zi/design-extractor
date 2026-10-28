// argv.mjs - accept arguments that arrived as one quoted string.
//
// The slash commands run `node ./scripts/cli.mjs "$ARGUMENTS"`. Without the
// quotes the caller's text is spliced into a shell line and every space splits a
// word, so a selector with a space, a query string and any stray glob reach the
// CLI in pieces. With them the shell passes exactly one argument and the CLI
// splits it itself, without a shell in the middle.
//
// This is not a security boundary. Double quotes stop word splitting and globbing
// but a shell still performs command substitution inside them, so `$(...)` and a
// backtick in the caller's text run before this code sees anything. The real
// boundary is that the caller passes a URL and flags, which the commands state and
// `assertSafeUrl` re-checks on the URL itself.

/**
 * Split `argv` the way a shell would split words, without any shell expansion.
 *
 * Returns `argv` unchanged unless it is a single element containing whitespace,
 * which is the shape a quoted `$ARGUMENTS` produces. A caller that already passes
 * separate arguments (a terminal, a test, another process) is left alone.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function normalizeArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) return argv;
  const raw = String(argv[0] ?? '');
  if (!/\s/.test(raw)) return [raw];

  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current) tokens.push(current);
  return tokens;
}
