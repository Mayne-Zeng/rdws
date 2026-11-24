// §11.20.27 W18: the content handling of a write tool output (Shell and
// Git). The first layer is the process (the Shell profile refuses the
// protected locations of the tree); this is the second layer, applied by
// the parent to the whole reassembled output before anything is paged,
// stored or projected, and once more by the FD4 projection over every
// tool result as a backstop (a hit there means the first pass failed).
// Known prefixes (the requirement tree, the runtime root, the account
// home, the node executable) are rewritten in the given order — the
// caller lists the longest first — and file:// URLs with them; lines of a
// credential shape are masked whole or in their value part. The shape
// list is finite and heuristic.
export type OutputPolicy = {
  prefixes: { value: string; replacement: string }[];
};
export type OutputCounts = { prefixes: number; credentials: number };

// A PEM private key block, a URL with a user name and password, a Bearer
// token, and an assignment whose name speaks of a credential.
const privateKeyBlock =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// A value that is already the mask is not a hit: the scan of a handled
// output must read zero, and the FD4 backstop must not count its own work.
const mask = '\\[redacted(?: private key)?\\]';
const urlCredentials = new RegExp(
  '([a-z][a-z0-9+.-]*://)(?!' + mask + ')[^/\\s:@]+:[^/\\s@]+@',
  'gi',
);
const bearer = new RegExp(
  '\\bBearer\\s+(?!' + mask + ')[A-Za-z0-9\\-._~+/]+=*',
  'g',
);
const assignment = new RegExp(
  '(^[ \\t]*(?:export[ \\t]+)?[\\w.-]*(?:token|secret|passw(?:or)?d|api[\\s._-]*key|private[\\s._-]*key|credential)[\\w.-]*[ \\t]*[:=][ \\t]*)(?!' +
    mask +
    ')\\S.*$',
  'gim',
);

export const outputScanPatterns = {
  privateKeyBlock,
  urlCredentials,
  bearer,
  assignment,
};

function countMatches(text: string, pattern: RegExp) {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : pattern.flags + 'g';
  return (text.match(new RegExp(pattern.source, flags)) ?? []).length;
}

// The prefixes that remain in the text, in raw form or inside a file:// URL.
export function scanOutput(text: string, policy: OutputPolicy): OutputCounts {
  let prefixes = 0;
  for (const { value } of policy.prefixes) {
    let index = text.indexOf(value);
    while (index !== -1) {
      prefixes++;
      index = text.indexOf(value, index + value.length);
    }
  }
  return {
    prefixes,
    credentials: Object.values(outputScanPatterns)
      .map((pattern) => countMatches(text, pattern))
      .reduce((sum, count) => sum + count, 0),
  };
}

export function scrubOutput(
  text: string,
  policy: OutputPolicy,
): OutputCounts & { text: string } {
  let out = text;
  let prefixes = 0;
  for (const { value, replacement } of policy.prefixes) {
    if (!value) continue;
    let index = out.indexOf(value);
    while (index !== -1) {
      prefixes++;
      out = out.slice(0, index) + replacement + out.slice(index + value.length);
      index = out.indexOf(value, index + replacement.length);
    }
  }
  let credentials = 0;
  out = out.replace(privateKeyBlock, () => {
    credentials++;
    return '[redacted private key]';
  });
  out = out.replace(urlCredentials, (_match, scheme: string) => {
    credentials++;
    return scheme + '[redacted]@';
  });
  out = out.replace(bearer, () => {
    credentials++;
    return 'Bearer [redacted]';
  });
  out = out.replace(assignment, (_match, lead: string) => {
    credentials++;
    return lead + '[redacted]';
  });
  return { text: out, prefixes, credentials };
}

// The prefixes of one execution: the requirement tree (rewritten to a
// relative path), the runtime root, the account home and the node
// executable, longest first so that a tree under the runtime root under
// the home is rewritten once, as the tree.
export function outputPolicy(input: {
  tree: string;
  runtimeRoot: string;
  home: string;
  node: string;
}): OutputPolicy {
  const prefixes = [
    { value: input.tree.replace(/\/$/, '') + '/', replacement: '' },
    { value: input.tree.replace(/\/$/, ''), replacement: '.' },
    { value: input.runtimeRoot.replace(/\/$/, ''), replacement: '<runtime>' },
    { value: input.home.replace(/\/$/, ''), replacement: '<home>' },
    { value: input.node, replacement: '<node>' },
  ].sort((a, b) => b.value.length - a.value.length);
  return { prefixes };
}

// The reassembly the parent performs before any handling: every chunk of a
// stream, in order, decoded once as a whole, then handled once. A prefix or
// a credential split across chunk boundaries is whole by then; handling
// the chunks one by one would miss exactly those.
export function reassembleAndScrub(
  chunks: readonly Uint8Array[],
  policy: OutputPolicy,
) {
  return scrubOutput(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    policy,
  );
}

// The head of a long output: at most the limit, cut at the last line end
// inside it; a first line longer than the limit is cut on a UTF-8
// boundary. Returns the text and the byte offset where the continuation
// starts.
export function outputHead(text: string, limit: number) {
  if (Buffer.byteLength(text) <= limit)
    return { text, from: Buffer.byteLength(text) };
  const bytes = Buffer.from(text);
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const cut = bytes.subarray(0, end);
  const newline = cut.lastIndexOf(10);
  const head = newline > 0 ? cut.subarray(0, newline + 1) : cut;
  return { text: head.toString('utf8'), from: head.length };
}

// A diff header that names a protected location: the whole result is an
// error without a body (W8), never an omission.
export function diffNamesProtectedPath(
  diff: string,
  protectedPath: (path: string) => boolean,
) {
  return diff
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('diff --git ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('rename from ') ||
        line.startsWith('rename to '),
    )
    .some((line) => {
      const renamed = /^rename (?:from|to) (\S+)$/.exec(line);
      if (renamed) return protectedPath(renamed[1]!);
      const paths = /(?:^|\s)(?:a|b)\/(\S+)/g;
      let match: RegExpExecArray | null;
      while ((match = paths.exec(line)))
        if (protectedPath(match[1]!)) return true;
      return false;
    });
}
