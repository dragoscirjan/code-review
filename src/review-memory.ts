import { createHash } from 'node:crypto';
import {
  ANALYZER_IDS,
  ANALYZER_RULE_REVISIONS,
  ANALYZER_RULES,
  type AnalyzerId,
  type AnalyzerRuleId,
} from './analyzer-config';
import type { ValidatedFinding } from './finding-validation';
import type { GitHubClient, PullRequestContext } from './github';
import type { FindingCategory } from './review-contract';
import { parseStrictJson } from './strict-json';

export const REVIEW_MEMORY_PATH = '.github/code-review-memory.json';
export const REVIEW_MEMORY_VERSION = 1 as const;
export const REVIEW_MEMORY_SEMANTIC_VERSION = 1 as const;
export const MAX_REVIEW_MEMORY_BYTES = 32_768;
export const MAX_MEMORY_SUPPRESSIONS = 32;
export const MAX_MEMORY_PREFERENCES = 32;
export const MAX_MEMORY_PATHS_PER_ENTRY = 8;
export const MAX_MEMORY_TOTAL_PATH_GLOBS = 256;
export const MAX_MEMORY_PATH_BYTES = 1_024;
export const MAX_MEMORY_REASON_BYTES = 512;
export const MAX_MEMORY_REFERENCE_BYTES = 512;
export const MAX_MEMORY_TTL_MS = 366 * 24 * 60 * 60 * 1_000;

export type ReviewMemoryMode = 'none' | 'base-config';
export type ReviewMemoryStatus = 'disabled' | 'missing' | 'enabled';

interface MemoryProvenance {
  author: string;
  kind: 'issue' | 'pull-request' | 'commit' | 'policy';
  reference: string;
}

interface CategoryScope {
  kind: 'category';
  category: FindingCategory;
}

interface AnalyzerRuleScope {
  kind: 'analyzer-rule';
  analyzer: AnalyzerId;
  rule: AnalyzerRuleId;
  revision: number;
}

export interface MemorySuppression {
  id: string;
  paths: string[];
  scope: CategoryScope | AnalyzerRuleScope;
  fingerprint: string | null;
  reason: string;
  provenance: MemoryProvenance;
  createdAt: string;
  expiresAt: string;
}

export interface MemoryPreference {
  id: string;
  paths: string[];
  categories: FindingCategory[];
  reason: string;
  provenance: MemoryProvenance;
  createdAt: string;
  expiresAt: string;
}

export interface AppliedMemoryEntry {
  id: string;
  repositoryDeclaredAuthor: string;
  digest: string;
}

export interface ReviewMemory {
  version: typeof REVIEW_MEMORY_VERSION;
  mode: ReviewMemoryMode;
  status: ReviewMemoryStatus;
  baseSha: string;
  blobSha?: string;
  configDigest: string;
  effectiveDigest: string;
  activeSuppressions: readonly MemorySuppression[];
  activePreferences: readonly MemoryPreference[];
  nextExpiryMs: number | null;
}

export interface MemoryApplication {
  findings: ValidatedFinding[];
  suppressedFindings: ValidatedFinding[];
  suppressedCount: number;
  appliedEntries: AppliedMemoryEntry[];
}

const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const AUTHOR_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const FORMAT_OR_CONTROL = /[\p{Cc}\p{Cf}]/u;
const CATEGORY_ORDER: readonly FindingCategory[] = ['correctness', 'security', 'regression', 'testing'];

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(JSON.stringify(value)).digest('base64url')}`;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Review memory contains a non-object value');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new Error('Review memory contains unknown or missing fields');
  }
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    !isWellFormed(value) ||
    FORMAT_OR_CONTROL.test(value)
  ) {
    throw new Error('Review memory contains invalid text');
  }
  return value;
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error('Review memory entry ID is invalid');
  return value;
}

function parseTimestamp(value: unknown): { canonical: string; milliseconds: number } {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    throw new Error('Review memory timestamp is not canonical UTC seconds');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace('Z', '.000Z')) {
    throw new Error('Review memory timestamp is invalid');
  }
  return { canonical: value, milliseconds };
}

function parseProvenance(value: unknown): MemoryProvenance {
  const source = object(value);
  exactKeys(source, ['author', 'kind', 'reference']);
  if (typeof source.author !== 'string' || !AUTHOR_PATTERN.test(source.author)) {
    throw new Error('Review memory provenance author is invalid');
  }
  if (!['issue', 'pull-request', 'commit', 'policy'].includes(String(source.kind))) {
    throw new Error('Review memory provenance kind is invalid');
  }
  const kind = source.kind as MemoryProvenance['kind'];
  const reference = boundedText(source.reference, MAX_MEMORY_REFERENCE_BYTES);
  if ((kind === 'issue' || kind === 'pull-request') && !/^#[1-9]\d*$/u.test(reference)) {
    throw new Error('Review memory issue provenance is invalid');
  }
  if (kind === 'commit' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(reference)) {
    throw new Error('Review memory commit provenance is invalid');
  }
  if (kind === 'policy') {
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      throw new Error('Review memory policy provenance is invalid');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.href !== reference) {
      throw new Error('Review memory policy provenance is invalid');
    }
  }
  return { author: source.author, kind, reference };
}

function validatePathPattern(pattern: unknown): string {
  if (
    typeof pattern !== 'string' ||
    !isWellFormed(pattern) ||
    pattern.length === 0 ||
    Buffer.byteLength(pattern, 'utf8') > MAX_MEMORY_PATH_BYTES ||
    pattern.startsWith('/') ||
    pattern.includes('\\') ||
    FORMAT_OR_CONTROL.test(pattern)
  ) {
    throw new Error('Review memory path pattern is invalid');
  }
  const segments = pattern.split('/');
  if (segments.length > 64 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Review memory path pattern is unsafe');
  }
  for (const segment of segments) {
    if (segment === '**') continue;
    if (segment.includes('**') || ['[', ']', '{', '}', '!', '(', ')'].some((token) => segment.includes(token))) {
      throw new Error('Review memory path pattern uses unsupported syntax');
    }
  }
  return pattern;
}

function parsePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEMORY_PATHS_PER_ENTRY) {
    throw new Error('Review memory paths are invalid');
  }
  const paths = value.map(validatePathPattern);
  if (new Set(paths).size !== paths.length) throw new Error('Review memory contains duplicate path patterns');
  return paths.sort();
}

function parseScope(value: unknown): CategoryScope | AnalyzerRuleScope {
  const scope = object(value);
  if (scope.kind === 'category') {
    exactKeys(scope, ['kind', 'category']);
    if (!CATEGORY_ORDER.includes(scope.category as FindingCategory)) {
      throw new Error('Review memory suppression category is invalid');
    }
    return { kind: 'category', category: scope.category as CategoryScope['category'] };
  }
  if (scope.kind === 'analyzer-rule') {
    exactKeys(scope, ['kind', 'analyzer', 'rule', 'revision']);
    if (!ANALYZER_IDS.includes(scope.analyzer as AnalyzerId)) throw new Error('Review memory analyzer is invalid');
    const analyzer = scope.analyzer as AnalyzerId;
    const rules = ANALYZER_RULES[analyzer] as readonly string[];
    if (typeof scope.rule !== 'string' || !rules.includes(scope.rule)) {
      throw new Error('Review memory analyzer rule is invalid');
    }
    const rule = scope.rule as AnalyzerRuleId;
    if (scope.revision !== ANALYZER_RULE_REVISIONS[rule]) {
      throw new Error('Review memory analyzer rule revision is invalid');
    }
    return { kind: 'analyzer-rule', analyzer, rule, revision: scope.revision as number };
  }
  throw new Error('Review memory suppression scope is invalid');
}

function parseCommon(
  entry: Record<string, unknown>,
  reviewStartedAtMs: number,
): Pick<MemorySuppression, 'id' | 'paths' | 'reason' | 'provenance' | 'createdAt' | 'expiresAt'> {
  const id = parseId(entry.id);
  const paths = parsePaths(entry.paths);
  const reason = boundedText(entry.reason, MAX_MEMORY_REASON_BYTES);
  const provenance = parseProvenance(entry.provenance);
  const created = parseTimestamp(entry.createdAt);
  const expires = parseTimestamp(entry.expiresAt);
  if (created.milliseconds > reviewStartedAtMs || expires.milliseconds <= reviewStartedAtMs) {
    throw new Error('Review memory entry is not currently effective');
  }
  if (expires.milliseconds <= created.milliseconds || expires.milliseconds - created.milliseconds > MAX_MEMORY_TTL_MS) {
    throw new Error('Review memory entry lifetime is invalid');
  }
  return { id, paths, reason, provenance, createdAt: created.canonical, expiresAt: expires.canonical };
}

function parseSuppression(value: unknown, reviewStartedAtMs: number): MemorySuppression {
  const entry = object(value);
  exactKeys(entry, ['id', 'paths', 'scope', 'fingerprint', 'reason', 'provenance', 'createdAt', 'expiresAt']);
  const common = parseCommon(entry, reviewStartedAtMs);
  const scope = parseScope(entry.scope);
  if (
    entry.fingerprint !== null &&
    (typeof entry.fingerprint !== 'string' || !DIGEST_PATTERN.test(entry.fingerprint))
  ) {
    throw new Error('Review memory fingerprint is invalid');
  }
  const fingerprint = entry.fingerprint as string | null;
  if (scope.kind === 'analyzer-rule' || (scope.kind === 'category' && scope.category === 'security')) {
    if (!fingerprint || common.paths.length !== 1 || common.paths.some((path) => /[*?]/u.test(path))) {
      throw new Error('Protected suppressions require an exact fingerprint and exact path');
    }
  }
  return { ...common, scope, fingerprint };
}

function parsePreference(value: unknown, reviewStartedAtMs: number): MemoryPreference {
  const entry = object(value);
  exactKeys(entry, ['id', 'paths', 'categories', 'reason', 'provenance', 'createdAt', 'expiresAt']);
  const common = parseCommon(entry, reviewStartedAtMs);
  if (
    !Array.isArray(entry.categories) ||
    entry.categories.length === 0 ||
    entry.categories.length > CATEGORY_ORDER.length
  ) {
    throw new Error('Review memory preference categories are invalid');
  }
  const categories = entry.categories.map((category) => {
    if (!CATEGORY_ORDER.includes(category as FindingCategory))
      throw new Error('Review memory preference category is invalid');
    return category as FindingCategory;
  });
  if (new Set(categories).size !== categories.length)
    throw new Error('Review memory preference categories are duplicated');
  categories.sort((left, right) => CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right));
  return { ...common, categories };
}

function canonicalEntries<T extends MemorySuppression | MemoryPreference>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function finalMemory(input: {
  mode: ReviewMemoryMode;
  status: ReviewMemoryStatus;
  baseSha: string;
  blobSha?: string;
  suppressions: readonly MemorySuppression[];
  preferences: readonly MemoryPreference[];
}): ReviewMemory {
  const activeSuppressions = canonicalEntries(input.suppressions);
  const activePreferences = canonicalEntries(input.preferences);
  const canonical = {
    version: REVIEW_MEMORY_VERSION,
    suppressions: activeSuppressions,
    preferences: activePreferences,
  };
  const configDigest = digest('code-review/repository-memory-config/v1', canonical);
  const effectiveDigest = digest('code-review/repository-memory-effective/v1', {
    semanticVersion: REVIEW_MEMORY_SEMANTIC_VERSION,
    mode: input.mode,
    status: input.status,
    configDigest,
    activeSuppressions,
    activePreferences,
  });
  const expiries = [...activeSuppressions, ...activePreferences].map((entry) => Date.parse(entry.expiresAt));
  return {
    version: REVIEW_MEMORY_VERSION,
    mode: input.mode,
    status: input.status,
    baseSha: input.baseSha,
    ...(input.blobSha ? { blobSha: input.blobSha } : {}),
    configDigest,
    effectiveDigest,
    activeSuppressions,
    activePreferences,
    nextExpiryMs: expiries.length > 0 ? Math.min(...expiries) : null,
  };
}

function assertNoSecrets(raw: string, secrets: readonly string[]): void {
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (raw.includes(secret) || (escaped !== secret && raw.includes(escaped))) {
      throw new Error('Review memory contains forbidden secret data');
    }
  }
}

export function disabledReviewMemory(baseSha: string): ReviewMemory {
  return finalMemory({ mode: 'none', status: 'disabled', baseSha, suppressions: [], preferences: [] });
}

export function parseReviewMemory(
  raw: string,
  baseSha: string,
  blobSha: string,
  reviewStartedAt: Date,
  secrets: readonly string[] = [],
): ReviewMemory {
  assertNoSecrets(raw, secrets);
  if (!SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(blobSha)) {
    throw new Error('Review memory revision identity is invalid');
  }
  const startedAtMs = reviewStartedAt.getTime();
  if (!Number.isFinite(startedAtMs)) throw new Error('Review memory evaluation time is invalid');
  const root = object(parseStrictJson(raw, MAX_REVIEW_MEMORY_BYTES, 12));
  // Scan decoded values as well as raw bytes so JSON escapes cannot conceal a credential.
  assertNoSecrets(JSON.stringify(root), secrets);
  exactKeys(root, ['version', 'suppressions', 'preferences']);
  if (root.version !== REVIEW_MEMORY_VERSION) throw new Error('Review memory version must be 1');
  if (!Array.isArray(root.suppressions) || root.suppressions.length > MAX_MEMORY_SUPPRESSIONS) {
    throw new Error('Review memory contains too many suppressions');
  }
  if (!Array.isArray(root.preferences) || root.preferences.length > MAX_MEMORY_PREFERENCES) {
    throw new Error('Review memory contains too many preferences');
  }
  const suppressions = root.suppressions.map((entry) => parseSuppression(entry, startedAtMs));
  const preferences = root.preferences.map((entry) => parsePreference(entry, startedAtMs));
  const all = [...suppressions, ...preferences];
  if (new Set(all.map((entry) => entry.id)).size !== all.length)
    throw new Error('Review memory entry IDs are ambiguous');
  if (all.reduce((count, entry) => count + entry.paths.length, 0) > MAX_MEMORY_TOTAL_PATH_GLOBS) {
    throw new Error('Review memory contains too many path patterns');
  }
  const selectors = suppressions.map((entry) => JSON.stringify([entry.paths, entry.scope, entry.fingerprint]));
  if (new Set(selectors).size !== selectors.length)
    throw new Error('Review memory contains duplicate suppression targets');
  return finalMemory({
    mode: 'base-config',
    status: 'enabled',
    baseSha,
    blobSha,
    suppressions,
    preferences,
  });
}

export async function loadReviewMemory(input: {
  client: Pick<GitHubClient, 'getRepositoryTextAtRevision'>;
  pullRequest: PullRequestContext;
  mode: ReviewMemoryMode;
  reviewStartedAt: Date;
  secrets?: readonly string[];
}): Promise<ReviewMemory> {
  if (input.mode === 'none') return disabledReviewMemory(input.pullRequest.baseSha);
  const result = await input.client.getRepositoryTextAtRevision(
    input.pullRequest,
    REVIEW_MEMORY_PATH,
    input.pullRequest.baseSha,
    MAX_REVIEW_MEMORY_BYTES,
    AbortSignal.timeout(10_000),
  );
  if (result.status === 'not-found') {
    return finalMemory({
      mode: 'base-config',
      status: 'missing',
      baseSha: input.pullRequest.baseSha,
      suppressions: [],
      preferences: [],
    });
  }
  if (result.status !== 'found' || result.truncated || result.text === undefined || !result.blobSha) {
    throw new Error('Review memory is unavailable or exceeds the limit');
  }
  return parseReviewMemory(
    result.text,
    input.pullRequest.baseSha,
    result.blobSha,
    input.reviewStartedAt,
    input.secrets,
  );
}

function matchSegment(pattern: string, value: string): boolean {
  const tokens = [...pattern];
  const characters = [...value];
  let tokenIndex = 0;
  let characterIndex = 0;
  let starIndex = -1;
  let starCharacterIndex = 0;
  while (characterIndex < characters.length) {
    const token = tokens[tokenIndex];
    if (token === '?' || token === characters[characterIndex]) {
      tokenIndex += 1;
      characterIndex += 1;
    } else if (token === '*') {
      starIndex = tokenIndex;
      tokenIndex += 1;
      starCharacterIndex = characterIndex;
    } else if (starIndex >= 0) {
      tokenIndex = starIndex + 1;
      starCharacterIndex += 1;
      characterIndex = starCharacterIndex;
    } else return false;
  }
  while (tokens[tokenIndex] === '*') tokenIndex += 1;
  return tokenIndex === tokens.length;
}

export function matchesMemoryPath(pattern: string, path: string): boolean {
  const patterns = pattern.split('/');
  const paths = path.split('/');
  if (paths.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  const width = paths.length + 1;
  let previous = new Uint8Array(width);
  previous[0] = 1;
  for (const segment of patterns) {
    const current = new Uint8Array(width);
    if (segment === '**') {
      current[0] = previous[0] as number;
      for (let index = 1; index < width; index += 1) {
        current[index] = Number(Boolean(previous[index] || current[index - 1]));
      }
    } else {
      for (let index = 1; index < width; index += 1) {
        if (previous[index - 1] && matchSegment(segment, paths[index - 1] as string)) current[index] = 1;
      }
    }
    previous = current;
  }
  return previous[paths.length] === 1;
}

function exactProtectedSelector(entry: MemorySuppression, finding: ValidatedFinding): boolean {
  return (
    entry.fingerprint === finding.fingerprint &&
    entry.paths.length === 1 &&
    entry.paths.every((path) => !/[*?]/u.test(path))
  );
}

function suppressionMatches(entry: MemorySuppression, finding: ValidatedFinding): boolean {
  if (!entry.paths.some((pattern) => matchesMemoryPath(pattern, finding.location.path))) return false;
  if (entry.fingerprint !== null && entry.fingerprint !== finding.fingerprint) return false;
  if (finding.category === 'security' || finding.severity === 'critical') {
    if (!exactProtectedSelector(entry, finding)) return false;
  }
  if (entry.scope.kind === 'category') {
    return finding.origin?.kind === 'model' && entry.scope.category === finding.category;
  }
  if (!exactProtectedSelector(entry, finding)) return false;
  const origin = finding.origin;
  return (
    origin?.kind === 'analyzer' &&
    origin.analyzer === entry.scope.analyzer &&
    origin.ruleId === entry.scope.rule &&
    origin.ruleRevision === entry.scope.revision
  );
}

function safeApplication(entry: MemorySuppression): AppliedMemoryEntry {
  return {
    id: entry.id,
    repositoryDeclaredAuthor: entry.provenance.author,
    digest: digest('code-review/repository-memory-entry/v1', entry),
  };
}

export function applyReviewMemory(findings: readonly ValidatedFinding[], memory?: ReviewMemory): MemoryApplication {
  if (!memory || memory.activeSuppressions.length === 0) {
    return { findings: [...findings], suppressedFindings: [], suppressedCount: 0, appliedEntries: [] };
  }
  const retained: ValidatedFinding[] = [];
  const suppressedFindings: ValidatedFinding[] = [];
  const applied = new Map<string, AppliedMemoryEntry>();
  let suppressedCount = 0;
  for (const finding of findings) {
    const matches = memory.activeSuppressions.filter((entry) => suppressionMatches(entry, finding));
    if (matches.length > 1) throw new Error('Review memory suppression match is ambiguous');
    const match = matches[0];
    if (!match) retained.push(finding);
    else {
      suppressedCount += 1;
      suppressedFindings.push(finding);
      applied.set(match.id, safeApplication(match));
    }
  }
  return {
    findings: retained,
    suppressedFindings,
    suppressedCount,
    appliedEntries: [...applied.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  };
}

export function memoryPreferencePriority(finding: ValidatedFinding, memory?: ReviewMemory): number {
  if (!memory) return 0;
  return memory.activePreferences.filter(
    (entry) =>
      entry.categories.includes(finding.category) &&
      entry.paths.some((pattern) => matchesMemoryPath(pattern, finding.location.path)),
  ).length;
}

export function assertReviewMemoryCurrent(memory: ReviewMemory, now: Date = new Date()): void {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Review memory evaluation time is invalid');
  if (memory.nextExpiryMs !== null && nowMs >= memory.nextExpiryMs) {
    throw new Error('Review memory expired during review execution');
  }
}
