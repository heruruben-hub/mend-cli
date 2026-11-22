// mend — a small command-line patch applier, written to the contract in SPEC.md.
// It understands the four edit formats AI models emit (unified diffs, SEARCH/REPLACE
// blocks, V4A patches and JSON edit objects), works out which one it has been given,
// locates the lines each edit refers to even when their numbering or indentation has
// drifted, and then rewrites the file tree all at once or not at all.
//
// Usage: `node main.ts [options] [PATCH]` on Node 22, standard library only.
//
// Graded trials set MAKEFUN_ENV_URL; in that case the block at the bottom of this
// file delegates to runner.ts instead of running the CLI. That delegation, and
// runner.ts itself, come from the competition kit and are not part of mend.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Faults. ParseFault aborts the whole run with a single `error: ...` line and
// exit code 2; EditFault is raised per edit and collected by run() (section 2).
// ---------------------------------------------------------------------------

class ParseFault {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

function isBlankLine(s: string): boolean {
  return s.trim().length === 0;
}

// A patch is read as LF-separated lines: one trailing CR is stripped from each
// line, and the empty piece after a final LF is not a line (section 3).
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const pieces = text.split('\n');
  if (pieces[pieces.length - 1] === '') pieces.pop();
  return pieces.map((piece) => (piece.endsWith('\r') ? piece.slice(0, -1) : piece));
}

// Section 3: a path is safe when it is relative, backslash-free, and none of
// its segments is empty, "." or "..".
function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// A file held as its lines, its own line break, and whether it ends with one
// (section 3). Edits work on this view; fromLines turns it back into bytes.
// ---------------------------------------------------------------------------

interface LineView {
  lines: string[];
  br: string;
  final: boolean;
}

function toLines(text: string): LineView {
  if (text === '') return { lines: [], br: '\n', final: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function fromLines(view: LineView): string {
  if (view.lines.length === 0) return '';
  return view.lines.join(view.br) + (view.final ? view.br : '');
}

// ---------------------------------------------------------------------------
// Three-tier line matching (section 5). tierCap is the loosest tier a search
// may use: 2 normally, 0 under --strict. run() sets it before parsing.
// ---------------------------------------------------------------------------

let tierCap = 2;

function dropTrailWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function dropBothWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function indentOf(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

function linesMatchAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return dropTrailWs(a) === dropTrailWs(b);
  return dropBothWs(a) === dropBothWs(b);
}

// Every index at or after `from` where needle matches lines consecutively.
function matchStarts(lines: string[], needle: string[], tier: number, from: number): number[] {
  const starts: number[] = [];
  for (let i = Math.max(0, from); i + needle.length <= lines.length; i += 1) {
    if (needle.every((nLine, k) => linesMatchAt(lines[i + k]!, nLine, tier))) starts.push(i);
  }
  return starts;
}

// The strictest tier at which needle occurs at or after `from`, together with
// every start position there; null when it occurs at no tier.
function locateAtBestTier(lines: string[], needle: string[], from: number): { tier: number; at: number[] } | null {
  let tier = 0;
  while (tier <= tierCap) {
    const at = matchStarts(lines, needle, tier, from);
    if (at.length > 0) return { tier, at };
    tier += 1;
  }
  return null;
}

// What newSeq becomes when it replaces the match at `at`: a context row
// (ctxIdx[k] holds its index into oldSeq) is copied from the file's own
// matched line, and at tier 2 every other non-blank row is re-indented from
// oldSeq's first line's indentation to the file's (section 5).
function renderReplacement(host: string[], at: number, oldSeq: string[], newSeq: string[], ctxIdx: (number | null)[], tier: number): string[] {
  const hostIndent = indentOf(host[at] ?? '');
  const patIndent = indentOf(oldSeq[0] ?? '');
  return newSeq.map((line, k) => {
    const oi = ctxIdx[k];
    if (oi !== null && oi !== undefined) return host[at + oi]!;
    if (tier === 2 && dropBothWs(line) !== '' && (patIndent === '' || line.startsWith(patIndent))) {
      return hostIndent + line.slice(patIndent.length);
    }
    return line;
  });
}

// ---------------------------------------------------------------------------
// The file tree as the edits leave it. `now` holds every path an edit has
// decided (null: deleted); anything else is read from disk on demand and
// cached in `pristine`. `moves` records each move edit as new path -> old
// path, which run() needs for the R output row (section 2). Nothing reaches
// the disk until every edit has succeeded (section 10).
// ---------------------------------------------------------------------------

type EditThunk = (tree: WorkTree) => void;

class WorkTree {
  private readonly pristine = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();

  original(p: string): string | null {
    if (!this.pristine.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.pristine.set(p, v);
    }
    return this.pristine.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6). readUnified walks the patch once, collecting
// sections (headers plus hunks); each section then becomes one edit.
// ---------------------------------------------------------------------------

interface DiffRow {
  kind: 'ctx' | 'old' | 'new' | 'eol';
  text: string;
  /** The patch line was completely empty: an empty context row, or a separator after the body. */
  rawBlank: boolean;
}

interface DiffHunk {
  a: number;
  body: DiffRow[];
}

interface DiffSection {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  oldNull: boolean;
  newNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: DiffHunk[];
}

function freshSection(): DiffSection {
  return { gitOld: null, gitNew: null, oldPath: null, newPath: null, oldNull: false, newNull: false, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
}

// The path on a --- or +++ header line: the text after the four-character
// prefix, cut at the first tab, trimmed, with a leading a/ or b/ removed;
// /dev/null means "no file on this side".
function pathFromHeader(line: string): { path: string | null; isNull: boolean } {
  let raw = line.slice(4);
  const tabAt = raw.indexOf('\t');
  if (tabAt >= 0) raw = raw.slice(0, tabAt);
  raw = raw.trim();
  if (raw === '/dev/null') return { path: null, isNull: true };
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return { path: raw, isNull: false };
}

function readUnified(lines: string[]): EditThunk[] {
  const found: DiffSection[] = [];
  let open: DiffSection | null = null;
  let inHead = false;
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (line.startsWith('diff --git')) {
      if (!line.startsWith('diff --git ')) throw new ParseFault(`error: parse ${idx + 1}`);
      const tail = line.slice(11);
      const sepAt = tail.startsWith('a/') ? tail.indexOf(' b/', 2) : -1;
      if (sepAt < 0 || sepAt === 2 || sepAt + 3 >= tail.length) throw new ParseFault(`error: parse ${idx + 1}`);
      open = freshSection();
      open.gitOld = tail.slice(2, sepAt);
      open.gitNew = tail.slice(sepAt + 3);
      found.push(open);
      inHead = true;
      idx += 1;
      continue;
    }
    if (pairAt(idx)) {
      if (open === null || !inHead) {
        open = freshSection();
        found.push(open);
        inHead = true;
      }
      const o = pathFromHeader(lines[idx]!);
      const n = pathFromHeader(lines[idx + 1]!);
      open.oldPath = o.path;
      open.oldNull = o.isNull;
      open.newPath = n.path;
      open.newNull = n.isNull;
      idx += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A --- line with no +++ after it, inside a section's header, is a
      // parse fault; anywhere else it is prose and skipped.
      if (open !== null && inHead) throw new ParseFault(`error: parse ${idx + 2}`);
      idx += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || open === null) throw new ParseFault(`error: parse ${idx + 1}`);
      inHead = false;
      const hunk: DiffHunk = { a: Number(m[1]), body: [] };
      open.hunks.push(hunk);
      idx += 1;
      while (idx < lines.length) {
        const row = lines[idx]!;
        if (row.startsWith('diff --git ') || pairAt(idx)) break;
        const mark = row[0];
        if (mark === ' ') hunk.body.push({ kind: 'ctx', text: row.slice(1), rawBlank: row.length === 1 });
        else if (mark === '-') hunk.body.push({ kind: 'old', text: row.slice(1), rawBlank: false });
        else if (mark === '+') hunk.body.push({ kind: 'new', text: row.slice(1), rawBlank: false });
        else if (mark === '\\') hunk.body.push({ kind: 'eol', text: '', rawBlank: false });
        else if (row === '') hunk.body.push({ kind: 'ctx', text: '', rawBlank: true });
        else break;
        idx += 1;
      }
      // Blank context rows at the tail of a body are separators, not content.
      while (hunk.body.length > 0) {
        const lastRow = hunk.body[hunk.body.length - 1]!;
        if (lastRow.kind === 'ctx' && lastRow.rawBlank) hunk.body.pop();
        else break;
      }
      continue;
    }
    if (open !== null && inHead) {
      if (line.startsWith('rename from ')) open.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) open.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) open.newFile = true;
      else if (line.startsWith('deleted file mode')) open.delFile = true;
      // index, mode, similarity and any other header lines carry no meaning here.
      idx += 1;
      continue;
    }
    // Outside headers and bodies, lines are ignored (prose, code fences).
    idx += 1;
  }
  return found.map(sectionToEdit);
}

// Applies one section's hunks, in order, to a file's text. Any hunk that
// cannot be placed fails the whole section with that hunk's fault.
function applyDiffHunks(before: string, hunks: DiffHunk[], path: string): string {
  const view = toLines(before);
  let cur = view.lines;
  let endsBr = view.final;
  let shift = 0;
  for (const h of hunks) {
    const oldSeq: string[] = [];
    const newSeq: string[] = [];
    const ctxIdx: (number | null)[] = [];
    for (const row of h.body) {
      if (row.kind === 'ctx') {
        oldSeq.push(row.text);
        newSeq.push(row.text);
        ctxIdx.push(oldSeq.length - 1);
      } else if (row.kind === 'old') oldSeq.push(row.text);
      else if (row.kind === 'new') {
        newSeq.push(row.text);
        ctxIdx.push(null);
      }
    }
    // A `\` row straight after the hunk's last context or + row takes the
    // final line break off the rewritten tail.
    let lastNewIdx = -1;
    h.body.forEach((row, k) => {
      if (row.kind === 'ctx' || row.kind === 'new') lastNewIdx = k;
    });
    const dropBreak = lastNewIdx >= 0 && h.body[lastNewIdx + 1]?.kind === 'eol';
    if (oldSeq.length === 0) {
      const at = Math.min(h.a + shift, cur.length);
      const atEnd = at === cur.length;
      cur = [...cur.slice(0, at), ...newSeq, ...cur.slice(at)];
      if (atEnd) endsBr = !dropBreak;
      shift += newSeq.length;
      continue;
    }
    const hit = locateAtBestTier(cur, oldSeq, 0);
    if (hit === null) throw new EditFault('no-match', path);
    const want = h.a - 1 + shift;
    let at = hit.at[0]!;
    for (const p of hit.at) if (Math.abs(p - want) < Math.abs(at - want)) at = p;
    const repl = renderReplacement(cur, at, oldSeq, newSeq, ctxIdx, hit.tier);
    const touchesEnd = at + oldSeq.length === cur.length;
    cur = [...cur.slice(0, at), ...repl, ...cur.slice(at + oldSeq.length)];
    if (touchesEnd) endsBr = !dropBreak;
    shift += newSeq.length - oldSeq.length;
  }
  return fromLines({ lines: cur, br: view.br, final: endsBr });
}

function sectionToEdit(s: DiffSection): EditThunk {
  const srcPath = s.oldPath ?? s.renameFrom ?? s.gitOld;
  const dstPath = s.newPath ?? s.renameTo ?? s.gitNew;
  const isCreate = s.oldNull || s.newFile;
  const isDelete = s.newNull || s.delFile;
  return (tree) => {
    if (isCreate) {
      const p = dstPath ?? srcPath;
      if (p === null) throw new EditFault('missing', '');
      if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      const body: string[] = [];
      let lastAddIdx = -1;
      let flatIdx = 0;
      let dropBreak = false;
      for (const h of s.hunks) {
        for (const row of h.body) {
          if (row.kind === 'new') {
            body.push(row.text);
            lastAddIdx = flatIdx;
            dropBreak = false;
          } else if (row.kind === 'eol' && flatIdx === lastAddIdx + 1) dropBreak = true;
          flatIdx += 1;
        }
      }
      tree.now.set(p, body.length === 0 ? '' : body.join('\n') + (dropBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = srcPath ?? dstPath;
      if (p === null) throw new EditFault('missing', '');
      if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) === null) throw new EditFault('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (srcPath !== null && dstPath !== null && srcPath !== dstPath) {
      // A move: the hunks rewrite the old file and the result lands at the
      // new path; the old path is deleted, and the move is remembered so
      // run() can print a single R row for the pair.
      if (!pathIsSafe(srcPath)) throw new EditFault('unsafe', srcPath);
      if (!pathIsSafe(dstPath)) throw new EditFault('unsafe', dstPath);
      const before = tree.get(srcPath);
      if (before === null) throw new EditFault('missing', srcPath);
      if (tree.get(dstPath) !== null) throw new EditFault('exists', dstPath);
      tree.now.set(dstPath, applyDiffHunks(before, s.hunks, srcPath));
      tree.now.set(srcPath, null);
      tree.moves.set(dstPath, srcPath);
      return;
    }
    const p = dstPath ?? srcPath;
    if (p === null) throw new EditFault('missing', '');
    if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new EditFault('missing', p);
    tree.now.set(p, applyDiffHunks(before, s.hunks, p));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7). Each block names its file on the nearest
// suitable line above its SEARCH marker and swaps one exact block of lines
// for another.
// ---------------------------------------------------------------------------

function readSearchReplace(lines: string[]): EditThunk[] {
  const plan: EditThunk[] = [];
  let lastPath: string | null = null;
  let scanFloor = 0;
  let idx = 0;
  while (idx < lines.length) {
    if (dropTrailWs(lines[idx]!) !== '<<<<<<< SEARCH') {
      idx += 1;
      continue;
    }
    const startNo = idx + 1;
    let eqAt = -1;
    for (let j = idx + 1; j < lines.length; j += 1) {
      if (dropTrailWs(lines[j]!) === '=======') {
        eqAt = j;
        break;
      }
    }
    if (eqAt < 0) throw new ParseFault(`error: parse ${startNo}`);
    let rpAt = -1;
    for (let j = eqAt + 1; j < lines.length; j += 1) {
      if (dropTrailWs(lines[j]!) === '>>>>>>> REPLACE') {
        rpAt = j;
        break;
      }
    }
    if (rpAt < 0) throw new ParseFault(`error: parse ${startNo}`);
    // The block's path is the closest line above the SEARCH marker, not
    // before the previous block, that is neither blank nor a code fence;
    // failing that, the block inherits the previous block's path.
    let path: string | null = null;
    for (let j = idx - 1; j >= scanFloor; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new ParseFault(`error: parse ${startNo}`);
    lastPath = path;
    plan.push(blockToEdit(path, lines.slice(idx + 1, eqAt), lines.slice(eqAt + 1, rpAt)));
    scanFloor = rpAt + 1;
    idx = rpAt + 1;
  }
  if (plan.length === 0) throw new ParseFault('error: parse 1');
  return plan;
}

function blockToEdit(path: string, oldLines: string[], newLines: string[]): EditThunk {
  return (tree) => {
    if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      // An empty SEARCH side means "create the file with these lines".
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    const view = toLines(before);
    const hit = locateAtBestTier(view.lines, oldLines, 0);
    if (hit === null) throw new EditFault('no-match', path);
    if (hit.at.length > 1) throw new EditFault('ambiguous', path);
    const at = hit.at[0]!;
    const repl = renderReplacement(view.lines, at, oldLines, newLines, newLines.map(() => null), hit.tier);
    const merged = [...view.lines.slice(0, at), ...repl, ...view.lines.slice(at + oldLines.length)];
    tree.now.set(path, fromLines({ lines: merged, br: view.br, final: view.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8): a Begin/End Patch frame holding Add, Delete and
// Update File sections; an update is a sequence of chunks applied in order
// against a forward-moving cursor.
// ---------------------------------------------------------------------------

interface V4aRow {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** The patch line was completely empty: an empty context row, or a separator after the section. */
  rawBlank: boolean;
}

interface V4aChunk {
  anchor: string | null;
  body: V4aRow[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: { text: string; rawBlank: boolean }[];
  chunks: V4aChunk[];
}

function readV4a(lines: string[]): EditThunk[] {
  const headIdx = lines.findIndex((l) => !isBlankLine(l));
  if (headIdx < 0) throw new ParseFault('error: parse 1');
  if (lines[headIdx]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${headIdx + 1}`);
  let tailIdx = lines.length - 1;
  while (tailIdx > headIdx && isBlankLine(lines[tailIdx]!)) tailIdx -= 1;
  if (lines[tailIdx]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let open: V4aSection | null = null;
  let openChunk: V4aChunk | null = null;
  // Blank context rows at the end of a chunk are separators, not content.
  const sealChunk = (): void => {
    if (openChunk === null) return;
    while (openChunk.body.length > 0) {
      const lastRow = openChunk.body[openChunk.body.length - 1]!;
      if (lastRow.kind === 'ctx' && lastRow.rawBlank) openChunk.body.pop();
      else break;
    }
    openChunk = null;
  };
  const sealSection = (): void => {
    if (open === null) return;
    sealChunk();
    if (open.kind === 'add') {
      while (open.addLines.length > 0 && open.addLines[open.addLines.length - 1]!.rawBlank) open.addLines.pop();
    }
    sections.push(open);
    open = null;
  };
  for (let i = headIdx + 1; i < tailIdx; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('*** Add File: ')) {
      sealSection();
      open = { kind: 'add', path: line.slice(14).trim(), line: lineNo, moveTo: null, addLines: [], chunks: [] };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sealSection();
      open = { kind: 'del', path: line.slice(17).trim(), line: lineNo, moveTo: null, addLines: [], chunks: [] };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      sealSection();
      open = { kind: 'upd', path: line.slice(17).trim(), line: lineNo, moveTo: null, addLines: [], chunks: [] };
      continue;
    }
    if (open === null) {
      if (isBlankLine(line)) continue;
      throw new ParseFault(`error: parse ${lineNo}`);
    }
    if (open.kind === 'add') {
      if (line.startsWith('+')) open.addLines.push({ text: line.slice(1), rawBlank: false });
      else if (line === '') open.addLines.push({ text: '', rawBlank: true });
      else throw new ParseFault(`error: parse ${lineNo}`);
      continue;
    }
    if (open.kind === 'del') throw new ParseFault(`error: parse ${lineNo}`);
    // An Update File section: at most one Move to line first, then chunks.
    if (line === '*** End of File') {
      if (openChunk !== null) openChunk.eof = true;
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (open.chunks.length === 0 && openChunk === null && open.moveTo === null) {
        open.moveTo = line.slice(13).trim();
        continue;
      }
      throw new ParseFault(`error: parse ${lineNo}`);
    }
    if (line.startsWith('@@')) {
      sealChunk();
      openChunk = { anchor: line.slice(2).trim() || null, body: [], eof: false };
      open.chunks.push(openChunk);
      continue;
    }
    const mark = line[0];
    if (mark === ' ' || mark === '-' || mark === '+' || line === '') {
      if (openChunk === null) {
        openChunk = { anchor: null, body: [], eof: false };
        open.chunks.push(openChunk);
      }
      if (line === '') openChunk.body.push({ kind: 'ctx', text: '', rawBlank: true });
      else openChunk.body.push({ kind: mark === ' ' ? 'ctx' : mark === '-' ? 'old' : 'new', text: line.slice(1), rawBlank: mark === ' ' && line.length === 1 });
      continue;
    }
    throw new ParseFault(`error: parse ${lineNo}`);
  }
  sealSection();
  for (const s of sections) {
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === null) throw new ParseFault(`error: parse ${s.line}`);
  }
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map(v4aSectionToEdit);
}

function v4aSectionToEdit(s: V4aSection): EditThunk {
  return (tree) => {
    if (!pathIsSafe(s.path)) throw new EditFault('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new EditFault('exists', s.path);
      const content = s.addLines.map((l) => l.text);
      tree.now.set(s.path, content.length === 0 ? '' : `${content.join('\n')}\n`);
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new EditFault('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !pathIsSafe(s.moveTo)) throw new EditFault('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new EditFault('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new EditFault('exists', s.moveTo);
    const view = toLines(before);
    let cur = view.lines;
    let scanPos = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const anchorHit = locateAtBestTier(cur, [chunk.anchor], scanPos);
        if (anchorHit === null) throw new EditFault('no-match', s.path);
        scanPos = anchorHit.at[0]! + 1;
      }
      const oldSeq: string[] = [];
      const newSeq: string[] = [];
      const ctxIdx: (number | null)[] = [];
      for (const row of chunk.body) {
        if (row.kind === 'ctx') {
          oldSeq.push(row.text);
          newSeq.push(row.text);
          ctxIdx.push(oldSeq.length - 1);
        } else if (row.kind === 'old') oldSeq.push(row.text);
        else {
          newSeq.push(row.text);
          ctxIdx.push(null);
        }
      }
      if (oldSeq.length === 0) {
        const at = chunk.eof ? cur.length : Math.min(scanPos, cur.length);
        cur = [...cur.slice(0, at), ...newSeq, ...cur.slice(at)];
        scanPos = at + newSeq.length;
        continue;
      }
      const hit = locateAtBestTier(cur, oldSeq, scanPos);
      if (hit === null) throw new EditFault('no-match', s.path);
      let at = -1;
      for (const p of hit.at) {
        if (chunk.eof && p + oldSeq.length !== cur.length) continue;
        at = p;
        break;
      }
      if (at < 0) throw new EditFault('no-match', s.path);
      const repl = renderReplacement(cur, at, oldSeq, newSeq, ctxIdx, hit.tier);
      cur = [...cur.slice(0, at), ...repl, ...cur.slice(at + oldSeq.length)];
      scanPos = at + repl.length;
    }
    const outText = fromLines({ lines: cur, br: view.br, final: view.final });
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, outText);
      tree.now.set(s.path, null);
      tree.moves.set(s.moveTo, s.path);
    } else {
      tree.now.set(s.path, outText);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9): text-editor tool calls — create, str_replace and
// insert — given either as one JSON array or as one object per line.
// ---------------------------------------------------------------------------

// One JSON edit object turned into an edit, or null when the value is not a
// recognisable edit object.
function jsonToEdit(v: unknown): EditThunk | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const mustExist = (tree: WorkTree): string => {
    if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree);
      const firstNl = before.indexOf('\n');
      const crlf = firstNl > 0 && before[firstNl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      let scan = t.indexOf(old);
      while (scan >= 0) {
        count += 1;
        scan = t.indexOf(old, scan + 1);
      }
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = mustExist(tree);
      const firstNl = before.indexOf('\n');
      const br = firstNl > 0 && before[firstNl - 1] === '\r' ? '\r\n' : '\n';
      const fileLines = before === '' ? [] : before.split(br);
      const endsWithBr = before !== '' && before.endsWith(br);
      if (endsWithBr) fileLines.pop();
      if (lineNo < 0 || lineNo > fileLines.length) throw new EditFault('no-match', p);
      fileLines.splice(lineNo, 0, ...add);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join(br) + (endsWithBr ? br : ''));
    };
  }
  return null;
}

function readJsonEdits(text: string, lines: string[]): EditThunk[] {
  const headIdx = lines.findIndex((l) => !isBlankLine(l));
  if (headIdx < 0) throw new ParseFault('error: parse 1');
  const plan: EditThunk[] = [];
  if (lines[headIdx]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${headIdx + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(`error: parse ${headIdx + 1}`);
    for (const item of parsed) {
      const e = jsonToEdit(item);
      if (e === null) throw new ParseFault(`error: parse ${headIdx + 1}`);
      plan.push(e);
    }
    return plan;
  }
  lines.forEach((l, i) => {
    if (isBlankLine(l)) return;
    let e: EditThunk | null = null;
    try {
      e = jsonToEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${i + 1}`);
    plan.push(e);
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Format detection (section 4) and the driver: parse the arguments, read the
// patch, turn it into edits, run them against a WorkTree with per-edit
// rollback, and — only when every edit succeeded — write the tree out and
// print the change report.
// ---------------------------------------------------------------------------

// Which format a patch is in, by the section 4 tests in their order; null
// when none of them holds.
function sniffFormat(lines: string[]): string | null {
  const headIdx = lines.findIndex((l) => !isBlankLine(l));
  if (headIdx < 0) return null;
  const head = lines[headIdx]!;
  if (head.trim() === '*** Begin Patch') return 'v4a';
  const firstChar = head.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  if (lines.some((l) => dropTrailWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  const hasGitHeader = lines.some((l) => l.startsWith('diff --git '));
  const hasPair = lines.some((l, i) => l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
  if (hasGitHeader || hasPair) return 'unified';
  return null;
}

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

interface ReportRow {
  key: string;
  line: string;
  path: string;
  now: string | null;
}

// The change report for a fully applied patch: one row per path whose state
// changed, ordered by byte order of the sort keys, with each successful move
// folded into a single R row (keyed by its new path) in place of that pair's
// D and A rows. Also returns the old paths of those moves, whose files run()
// still has to remove from disk afterwards.
function buildReport(work: WorkTree): { rows: ReportRow[]; gonePaths: Set<string> } {
  const gonePaths = new Set<string>();
  const bornPaths = new Set<string>();
  for (const [np, op] of work.moves) {
    if (work.original(op) !== null && work.now.get(op) === null && work.original(np) === null && work.now.get(np) !== null) {
      gonePaths.add(op);
      bornPaths.add(np);
    }
  }
  const rows: ReportRow[] = [];
  for (const np of bornPaths) rows.push({ key: np, line: `R ${work.moves.get(np)!} -> ${np}`, path: np, now: work.now.get(np)! });
  for (const p of work.now.keys()) {
    if (gonePaths.has(p) || bornPaths.has(p)) continue;
    const was = work.original(p);
    const nowVal = work.now.get(p)!;
    if (was === nowVal) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : nowVal === null ? 'D' : 'M'} ${p}`, path: p, now: nowVal });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  return { rows, gonePaths };
}

function run(args: string[]): { code: number; out: string[] } {
  let fmtName: string | null = null;
  let dryRun = false;
  let strictOnly = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of args) {
    if (!afterDashDash && a === '--') afterDashDash = true;
    else if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && fmtName === null && FORMAT_NAMES.includes(a.slice(9))) fmtName = a.slice(9);
      else if (a === '--check' && !dryRun) dryRun = true;
      else if (a === '--strict' && !strictOnly) strictOnly = true;
      else return { code: 2, out: ['error: usage'] };
    } else positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchPath = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const plines = splitPatch(patchText);
  const fmtKind = fmtName === null || fmtName === 'auto' ? sniffFormat(plines) : fmtName;
  if (fmtKind === null) return { code: 2, out: ['error: format'] };
  tierCap = strictOnly ? 0 : 2;
  let plan: EditThunk[];
  try {
    plan =
      fmtKind === 'json'
        ? readJsonEdits(patchText, plines)
        : fmtKind === 'unified'
          ? readUnified(plines)
          : fmtKind === 'search-replace'
            ? readSearchReplace(plines)
            : readV4a(plines);
    if (plan.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const work = new WorkTree();
  const faults: EditFault[] = [];
  for (const edit of plan) {
    const snapNow = new Map(work.now);
    const snapMoves = new Map(work.moves);
    try {
      edit(work);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      work.now.clear();
      for (const [k, v] of snapNow) work.now.set(k, v);
      work.moves.clear();
      for (const [k, v] of snapMoves) work.moves.set(k, v);
      faults.push(e);
    }
  }
  if (faults.length > 0) return { code: 1, out: [...faults.map((f) => `error: ${f.code} ${f.path}`), `failed: ${faults.length} of ${plan.length} edits`] };
  const { rows, gonePaths } = buildReport(work);
  const output: string[] = [];
  for (const r of rows) {
    output.push(r.line);
    if (dryRun) continue;
    if (r.now === null) rmSync(r.path, { force: true });
    else {
      mkdirSync(dirname(r.path), { recursive: true });
      writeFileSync(r.path, r.now);
    }
  }
  if (!dryRun) for (const op of gonePaths) rmSync(op, { force: true });
  return { code: 0, out: [...output, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
