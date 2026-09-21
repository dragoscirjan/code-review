import { createHash } from 'node:crypto';
import { extname, basename, dirname } from 'node:path/posix';
import type { GitHubIssueContext } from './github';
import type { UnifiedDiff, UnifiedDiffLine } from './unified-diff';

export const MAX_CONTEXT_BYTES = 50_000;
export const MAX_CONTEXT_ANCHORS = 6;
export const MAX_QUERY_TIMEOUT_MS = 5_000;
export const MAX_QUERY_PHASE_TIMEOUT_MS = 45_000;
export const MAX_QUERY_OUTPUT_BYTES = 16_000;
export const MAX_QUERY_PHASE_OUTPUT_BYTES = 128_000;
export const MAX_QUERY_INCLUDED_BYTES = 6_000;
export const MAX_BASE_GUIDANCE_BYTES_PER_FILE = 8_000;
export const MAX_CONFIGURATION_FILES = 4;
export const MAX_CONFIGURATION_CANDIDATES = 32;
export const MAX_CONFIGURATION_CONTEXT_BYTES = 8_000;
export const MAX_LINKED_ISSUES = 3;
export const MAX_ISSUE_RESPONSE_BYTES = 64_000;
export const MAX_ISSUE_TITLE_BYTES = 512;
export const MAX_ISSUE_CRITERIA_BYTES = 6_000;

export type ContextQueryKind = 'definition-and-types' | 'callers-and-tests' | 'callees' | 'configuration';
export type ContextSourceStatus =
  'included' | 'empty' | 'truncated' | 'unavailable' | 'timed-out' | 'budget-exhausted' | 'unsupported' | 'disabled';
export type ContextSourceKind = 'base-guidance' | 'base-configuration' | 'code-index' | 'github-issue';

export interface DiffAnchorProvenance {
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  lineKind: 'addition' | 'deletion' | 'context';
}

export interface ContextAnchor {
  value: string;
  kind: 'symbol' | 'type' | 'lexical';
  language: string;
  path: string;
  provenance: DiffAnchorProvenance[];
}

export interface ContextQueryPlan {
  id: string;
  kind: ContextQueryKind;
  anchor: ContextAnchor;
}

export interface ContextSourceProvenance {
  source: ContextSourceKind;
  sourceId: string;
  revision?: string;
  indexer?: 'cgc' | 'gitnexus';
  indexerVersion?: string;
  queryId?: string;
  queryKind?: ContextQueryKind;
  status: ContextSourceStatus;
  acquiredBytes: number;
  includedBytes: number;
  contentDigest?: string;
  blobSha?: string;
  reason?: string;
}

export interface ReviewContextItem {
  source: ContextSourceProvenance;
  content?: string;
}

export interface ContextRuntimeSummary {
  indexer: 'none' | 'cgc' | 'gitnexus';
  anchorsPlanned: number;
  queriesPlanned: number;
  queriesCompleted: number;
  queriesTimedOut: number;
  queryByteLimitHits: number;
  queryBudgetSkipped: number;
  guidance: { agents: ContextSourceStatus; contributing: ContextSourceStatus };
  configuration: { candidates: number; included: number; unavailable: number; truncated: number };
  linkedIssues: { discovered: number; fetched: number; unavailable: number };
}

export interface ReviewContextMetadata {
  version: 1;
  maximumBytes: number;
  includedBytes: number;
  truncated: boolean;
  unavailableSourceCount: number;
  truncatedSourceCount: number;
  anchorsPlanned: number;
  queriesPlanned: number;
  queriesCompleted: number;
  queriesTimedOut: number;
  queryByteLimitHits: number;
  queryBudgetSkipped: number;
  indexer: 'none' | 'cgc' | 'gitnexus';
  guidance: { agents: ContextSourceStatus; contributing: ContextSourceStatus };
  configuration: { candidates: number; included: number; unavailable: number; truncated: number };
  linkedIssues: { discovered: number; fetched: number; unavailable: number };
}

export interface ReviewContextBundle {
  version: 1;
  trust: 'untrusted-data';
  items: ReviewContextItem[];
  metadata: ReviewContextMetadata;
  digest: string;
}

interface LanguageProfile {
  name: string;
  declarations: Array<{ kind: 'symbol' | 'type'; pattern: RegExp }>;
  keywords: ReadonlySet<string>;
}

const commonKeywords = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'interface',
  'let',
  'module',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'require',
  'return',
  'static',
  'struct',
  'super',
  'switch',
  'this',
  'throw',
  'trait',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'use',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

const profiles: Record<string, LanguageProfile> = {
  '.js': javascriptProfile(),
  '.jsx': javascriptProfile(),
  '.mjs': javascriptProfile(),
  '.cjs': javascriptProfile(),
  '.ts': javascriptProfile(),
  '.tsx': javascriptProfile(),
  '.py': profile('python', [
    ['type', /^\s*(?:class)\s+([\p{ID_Start}_][\p{ID_Continue}_]*)/u],
    ['symbol', /^\s*(?:async\s+)?def\s+([\p{ID_Start}_][\p{ID_Continue}_]*)/u],
  ]),
  '.go': profile('go', [
    ['type', /^\s*type\s+([\p{ID_Start}_][\p{ID_Continue}_]*)\s+(?:struct|interface)\b/u],
    ['symbol', /^\s*func\s+(?:\([^)]*\)\s*)?([\p{ID_Start}_][\p{ID_Continue}_]*)\s*\(/u],
  ]),
  '.rs': profile('rust', [
    ['type', /^\s*(?:pub\s+)?(?:struct|enum|trait|type)\s+([\p{ID_Start}_][\p{ID_Continue}_]*)/u],
    ['symbol', /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([\p{ID_Start}_][\p{ID_Continue}_]*)/u],
  ]),
  '.java': cLikeProfile('java'),
  '.cs': cLikeProfile('csharp'),
  '.c': cLikeProfile('c'),
  '.h': cLikeProfile('c'),
  '.cc': cLikeProfile('cpp'),
  '.cpp': cLikeProfile('cpp'),
  '.cxx': cLikeProfile('cpp'),
  '.hh': cLikeProfile('cpp'),
  '.hpp': cLikeProfile('cpp'),
  '.php': profile('php', [
    ['type', /^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/u],
    ['symbol', /^\s*(?:public\s+|protected\s+|private\s+|static\s+)*function\s+([A-Za-z_][A-Za-z0-9_]*)/u],
  ]),
  '.rb': profile('ruby', [
    ['type', /^\s*(?:class|module)\s+([A-Za-z_][A-Za-z0-9_:]*)/u],
    ['symbol', /^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/u],
  ]),
};

function profile(name: string, declarations: Array<['symbol' | 'type', RegExp]>): LanguageProfile {
  return {
    name,
    declarations: declarations.map(([kind, pattern]) => ({ kind, pattern })),
    keywords: commonKeywords,
  };
}

function javascriptProfile(): LanguageProfile {
  return profile('javascript-typescript', [
    [
      'type',
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|enum|type)\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u,
    ],
    ['symbol', /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\p{ID_Start}_$][\p{ID_Continue}$]*)/u],
    [
      'symbol',
      /^\s*(?:export\s+)?(?:const|let|var)\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\p{ID_Start}_$][\p{ID_Continue}$]*)\s*=>/u,
    ],
  ]);
}

function cLikeProfile(name: string): LanguageProfile {
  return profile(name, [
    [
      'type',
      /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|struct|enum)\s+([\p{ID_Start}_][\p{ID_Continue}_]*)/u,
    ],
    ['symbol', /^\s*(?:[\w<>:*&,\s]+\s+)?([\p{ID_Start}_][\p{ID_Continue}_]*)\s*\([^;{}]*\)\s*(?:\{|$)/u],
  ]);
}

function lineLocation(file: UnifiedDiff['files'][number], line: UnifiedDiffLine): DiffAnchorProvenance | undefined {
  if (line.kind === 'addition' && line.newLine && file.newPath) {
    return { path: file.newPath, side: 'RIGHT', line: line.newLine, lineKind: 'addition' };
  }
  if (line.kind === 'deletion' && line.oldLine && file.oldPath) {
    return { path: file.oldPath, side: 'LEFT', line: line.oldLine, lineKind: 'deletion' };
  }
  if (line.kind === 'context' && line.newLine && file.newPath) {
    return { path: file.newPath, side: 'RIGHT', line: line.newLine, lineKind: 'context' };
  }
  return undefined;
}

function declaration(
  profileValue: LanguageProfile,
  text: string,
): { value: string; kind: 'symbol' | 'type' } | undefined {
  if (
    /^\s*(?:import|export\s+.+\s+from|require\s*\(|include\b|#include\b|using\b|use\b|package\b|module\b)/u.test(text)
  ) {
    return undefined;
  }
  for (const candidate of profileValue.declarations) {
    const match = candidate.pattern.exec(text);
    const value = match?.[1];
    if (value && Buffer.byteLength(value, 'utf8') <= 128) return { value, kind: candidate.kind };
  }
  return undefined;
}

function lexicalTokens(profileValue: LanguageProfile, text: string): string[] {
  const withoutComments = text
    .replace(/\/\/.*$/u, '')
    .replace(/#.*$/u, '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, ' ');
  if (/^\s*(?:import|include|require|use|package|module)\b/u.test(withoutComments)) return [];
  return [...withoutComments.matchAll(/[\p{ID_Start}_$][\p{ID_Continue}$]*/gu)]
    .map((match) => match[0])
    .filter(
      (token) =>
        [...token].length >= 3 &&
        !profileValue.keywords.has(token.toLowerCase()) &&
        Buffer.byteLength(token, 'utf8') <= 128,
    );
}

interface RankedAnchor {
  anchor: ContextAnchor;
  rank: number;
  sequence: number;
}

function provenanceEqual(left: DiffAnchorProvenance, right: DiffAnchorProvenance): boolean {
  return (
    left.path === right.path && left.side === right.side && left.line === right.line && left.lineKind === right.lineKind
  );
}

function addRankedAnchor(
  ranked: RankedAnchor[],
  byKey: Map<string, RankedAnchor>,
  input: Omit<ContextAnchor, 'provenance'> & { provenance: DiffAnchorProvenance; rank: number },
  sequence: number,
): void {
  const key = `${input.path}\0${input.value}\0${input.kind}`;
  const previous = byKey.get(key);
  if (previous) {
    previous.rank = Math.min(previous.rank, input.rank);
    if (!previous.anchor.provenance.some((item) => provenanceEqual(item, input.provenance))) {
      previous.anchor.provenance.push(input.provenance);
    }
    return;
  }
  const created: RankedAnchor = {
    anchor: {
      value: input.value,
      kind: input.kind,
      language: input.language,
      path: input.path,
      provenance: [input.provenance],
    },
    rank: input.rank,
    sequence,
  };
  ranked.push(created);
  byKey.set(key, created);
}

function declarationRank(lineKind: DiffAnchorProvenance['lineKind'], kind: 'type' | 'symbol'): number {
  if (lineKind === 'addition') return kind === 'type' ? 0 : 1;
  if (lineKind === 'deletion') return kind === 'type' ? 2 : 3;
  return kind === 'type' ? 6 : 7;
}

/** Extracts a small deterministic set of base-index anchors from only the model-visible parsed diff. */
export function extractContextAnchors(diff: UnifiedDiff): ContextAnchor[] {
  const ranked: RankedAnchor[] = [];
  const byKey = new Map<string, RankedAnchor>();
  let sequence = 0;

  for (const file of diff.files) {
    const languagePath = file.newPath ?? file.oldPath;
    const basePath = file.oldPath ?? file.newPath;
    if (!languagePath || !basePath) continue;
    const language = profiles[extname(languagePath).toLowerCase()];
    if (!language) continue;
    const anchorsBeforeFile = byKey.size;
    const tokenLocations = new Map<string, { count: number; locations: DiffAnchorProvenance[] }>();
    const changedLines = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== 'context'));

    for (const hunk of file.hunks) {
      let changedDeclarationFound = false;
      for (const line of hunk.lines.filter((candidate) => candidate.kind !== 'context')) {
        const provenance = lineLocation(file, line);
        if (!provenance) continue;
        const found = declaration(language, line.text);
        if (found) {
          changedDeclarationFound = true;
          addRankedAnchor(
            ranked,
            byKey,
            {
              ...found,
              language: language.name,
              path: basePath,
              provenance,
              rank: declarationRank(line.kind, found.kind),
            },
            sequence++,
          );
        }
        for (const token of lexicalTokens(language, line.text)) {
          const occurrence = tokenLocations.get(token) ?? { count: 0, locations: [] };
          occurrence.count += 1;
          if (!occurrence.locations.some((item) => provenanceEqual(item, provenance))) {
            occurrence.locations.push(provenance);
          }
          tokenLocations.set(token, occurrence);
        }
      }
      if (!changedDeclarationFound) {
        for (const line of hunk.lines.filter((candidate) => candidate.kind === 'context')) {
          const provenance = lineLocation(file, line);
          const found = declaration(language, line.text);
          if (!provenance || !found) continue;
          addRankedAnchor(
            ranked,
            byKey,
            {
              ...found,
              language: language.name,
              path: basePath,
              provenance,
              rank: declarationRank('context', found.kind),
            },
            sequence++,
          );
        }
      }
    }

    for (const [value, occurrence] of [...tokenLocations.entries()].sort(
      (left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0], 'en'),
    )) {
      if (occurrence.count < 2) continue;
      const lexicalRank = occurrence.locations.some((item) => item.lineKind === 'addition') ? 4 : 5;
      for (const provenance of occurrence.locations) {
        addRankedAnchor(
          ranked,
          byKey,
          { value, kind: 'lexical', language: language.name, path: basePath, provenance, rank: lexicalRank },
          sequence++,
        );
      }
    }

    if (byKey.size === anchorsBeforeFile) {
      const stem = basename(languagePath, extname(languagePath));
      if (/^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(stem) && [...stem].length >= 3) {
        const line = changedLines[0] ?? file.hunks.flatMap((hunk) => hunk.lines)[0];
        const provenance = line ? lineLocation(file, line) : undefined;
        if (provenance) {
          addRankedAnchor(
            ranked,
            byKey,
            { value: stem, kind: 'lexical', language: language.name, path: basePath, provenance, rank: 8 },
            sequence++,
          );
        }
      }
    }
  }

  return ranked
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.sequence - right.sequence ||
        left.anchor.value.localeCompare(right.anchor.value, 'en'),
    )
    .slice(0, MAX_CONTEXT_ANCHORS)
    .map(({ anchor }) => anchor);
}

export interface BaseConfigurationCandidate {
  path: string;
  proximity: number;
}

const configurationNamesByExtension: Record<string, readonly string[]> = {
  '.js': ['jsconfig.json', 'package.json'],
  '.jsx': ['jsconfig.json', 'package.json'],
  '.mjs': ['jsconfig.json', 'package.json'],
  '.cjs': ['jsconfig.json', 'package.json'],
  '.ts': ['package.json', 'tsconfig.base.json', 'tsconfig.build.json', 'tsconfig.json'],
  '.tsx': ['package.json', 'tsconfig.base.json', 'tsconfig.build.json', 'tsconfig.json'],
  '.py': ['pyproject.toml', 'setup.cfg', 'tox.ini'],
  '.go': ['go.mod'],
  '.rs': ['Cargo.toml'],
  '.java': ['build.gradle', 'build.gradle.kts', 'pom.xml'],
  '.cs': ['Directory.Build.props'],
  '.c': ['CMakeLists.txt', 'Makefile'],
  '.h': ['CMakeLists.txt', 'Makefile'],
  '.cc': ['CMakeLists.txt', 'Makefile'],
  '.cpp': ['CMakeLists.txt', 'Makefile'],
  '.cxx': ['CMakeLists.txt', 'Makefile'],
  '.hh': ['CMakeLists.txt', 'Makefile'],
  '.hpp': ['CMakeLists.txt', 'Makefile'],
};

const allowlistedConfigurationNames = new Set(Object.values(configurationNamesByExtension).flat());

/** Plans a bounded exact-base configuration search by nearest changed-path ancestor and then lexical path. */
export function planBaseConfigurationCandidates(diff: UnifiedDiff): BaseConfigurationCandidate[] {
  const byPath = new Map<string, number>();
  for (const file of diff.files) {
    for (const changedPath of [
      ...new Set([file.oldPath, file.newPath].filter((path): path is string => Boolean(path))),
    ]) {
      const changedName = basename(changedPath);
      const names = allowlistedConfigurationNames.has(changedName)
        ? [changedName]
        : [...(configurationNamesByExtension[extname(changedPath).toLowerCase()] ?? [])];
      if (names.length === 0) continue;
      let directory = dirname(changedPath);
      let proximity = 0;
      while (true) {
        for (const name of names) {
          const path = directory === '.' ? name : `${directory}/${name}`;
          const previous = byPath.get(path);
          if (previous === undefined || proximity < previous) byPath.set(path, proximity);
        }
        if (directory === '.') break;
        directory = dirname(directory);
        proximity += 1;
      }
    }
  }
  return [...byPath.entries()]
    .map(([path, proximity]) => ({ path, proximity }))
    .sort((left, right) => left.proximity - right.proximity || left.path.localeCompare(right.path, 'en'))
    .slice(0, MAX_CONFIGURATION_CANDIDATES);
}

export function planContextQueries(anchors: readonly ContextAnchor[]): ContextQueryPlan[] {
  const plans: ContextQueryPlan[] = [];
  const kinds: ContextQueryKind[] = ['definition-and-types', 'callers-and-tests', 'callees', 'configuration'];
  for (const kind of kinds) {
    anchors.forEach((anchor) => {
      plans.push({
        id: `q${String(plans.length + 1).padStart(2, '0')}`,
        kind,
        anchor: { ...anchor, provenance: [...anchor.provenance] },
      });
    });
  }
  return plans;
}

export function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return { value, truncated: false };
  const bytes = Buffer.from(value, 'utf8');
  let end = Math.min(bytes.length, Math.max(0, maximumBytes));
  while (end >= 0) {
    try {
      return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { value: '', truncated: true };
}

function acceptanceCriteriaText(issue: GitHubIssueContext): string | undefined {
  const lines = issue.body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  let start = -1;
  let level = 7;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s*(acceptance criteria|definition of done|requirements)\s*:?[ \t]*$/iu.exec(
      lines[index] ?? '',
    );
    if (heading) {
      start = index + 1;
      level = heading[1]?.length ?? 7;
      break;
    }
    const label = /^\s*(?:\*\*|__)?(acceptance criteria|definition of done|requirements)(?:\*\*|__)?\s*:\s*$/iu.exec(
      lines[index] ?? '',
    );
    if (label) {
      start = index + 1;
      level = 7;
      break;
    }
  }
  if (start < 0) return undefined;
  const selected: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const nextHeading = /^(#{1,6})\s+/u.exec(lines[index] ?? '');
    if (nextHeading && (nextHeading[1]?.length ?? 7) <= level) break;
    selected.push(lines[index] ?? '');
  }
  const criteria = selected.join('\n').trim();
  return criteria || undefined;
}

export function extractAcceptanceCriteria(issue: GitHubIssueContext): string | undefined {
  const criteria = acceptanceCriteriaText(issue);
  return criteria === undefined ? undefined : truncateUtf8(criteria, MAX_ISSUE_CRITERIA_BYTES).value;
}

export function extractAcceptanceCriteriaWithMetadata(
  issue: GitHubIssueContext,
): { criteria: string; originalBytes: number; truncated: boolean } | undefined {
  const criteria = acceptanceCriteriaText(issue);
  if (criteria === undefined) return undefined;
  const limited = truncateUtf8(criteria, MAX_ISSUE_CRITERIA_BYTES);
  return {
    criteria: limited.value,
    originalBytes: Buffer.byteLength(criteria, 'utf8'),
    truncated: limited.truncated,
  };
}

function serialized(items: readonly ReviewContextItem[]): string {
  return JSON.stringify({ version: 1, trust: 'untrusted-data', items });
}

function sourceWithContent(source: ContextSourceProvenance, content: string | undefined): ReviewContextItem {
  const includedBytes = content === undefined ? 0 : Buffer.byteLength(content, 'utf8');
  return {
    source: {
      ...source,
      includedBytes,
      ...(content === undefined
        ? {}
        : { contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}` }),
    },
    ...(content === undefined ? {} : { content }),
  };
}

/** Packs provenance-bearing sources against the exact serialized model-visible envelope size. */
export function packReviewContext(
  candidates: readonly ReviewContextItem[],
  runtime: ContextRuntimeSummary,
  maximumBytes = MAX_CONTEXT_BYTES,
): ReviewContextBundle {
  const items: ReviewContextItem[] = [];
  const truncatedCandidateIndexes = new Set<number>();
  candidates.forEach((candidate, index) => {
    if (candidate.source.status === 'truncated') truncatedCandidateIndexes.add(index);
  });
  let truncated = false;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as ReviewContextItem;
    const normalized = sourceWithContent(candidate.source, candidate.content);
    if (Buffer.byteLength(serialized([...items, normalized]), 'utf8') <= maximumBytes) {
      items.push(normalized);
      continue;
    }
    truncated = true;
    for (let omittedIndex = index; omittedIndex < candidates.length; omittedIndex += 1) {
      truncatedCandidateIndexes.add(omittedIndex);
    }
    if (candidate.content === undefined || candidate.content.length === 0) break;
    let low = 0;
    let high = Buffer.byteLength(candidate.content, 'utf8');
    let best: ReviewContextItem | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const prefix = truncateUtf8(candidate.content, middle).value;
      const trial = sourceWithContent({ ...candidate.source, status: 'truncated' }, prefix);
      if (Buffer.byteLength(serialized([...items, trial]), 'utf8') <= maximumBytes) {
        best = trial;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best && best.content) items.push(best);
    break;
  }
  const contextText = serialized(items);
  const unavailableSourceCount = candidates.filter((item) =>
    ['unavailable', 'timed-out', 'budget-exhausted', 'unsupported'].includes(item.source.status),
  ).length;
  const truncatedSourceCount = truncatedCandidateIndexes.size;
  const metadata: ReviewContextMetadata = {
    version: 1,
    maximumBytes,
    includedBytes: Buffer.byteLength(contextText, 'utf8'),
    truncated: truncated || truncatedSourceCount > 0,
    unavailableSourceCount,
    truncatedSourceCount,
    anchorsPlanned: runtime.anchorsPlanned,
    queriesPlanned: runtime.queriesPlanned,
    queriesCompleted: runtime.queriesCompleted,
    queriesTimedOut: runtime.queriesTimedOut,
    queryByteLimitHits: runtime.queryByteLimitHits,
    queryBudgetSkipped: runtime.queryBudgetSkipped,
    indexer: runtime.indexer,
    guidance: runtime.guidance,
    configuration: runtime.configuration,
    linkedIssues: runtime.linkedIssues,
  };
  return {
    version: 1,
    trust: 'untrusted-data',
    items,
    metadata,
    digest: `sha256:${createHash('sha256').update(contextText).digest('hex')}`,
  };
}

export function serializeReviewContext(bundle: ReviewContextBundle): string {
  const value = serialized(bundle.items);
  if (Buffer.byteLength(value, 'utf8') !== bundle.metadata.includedBytes) {
    throw new Error('Review context byte accounting is inconsistent');
  }
  return value;
}
