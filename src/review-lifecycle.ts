import { createHash } from 'node:crypto';
import type { ValidatedFinding } from './finding-validation';
import type { ReviewBackend } from './review';
import type { FindingCategory, FindingSeverity } from './review-contract';
import type { UnifiedDiff, UnifiedDiffFile, UnifiedDiffHunk, UnifiedDiffLine } from './unified-diff';

export const REVIEW_STATE_VERSION = 1 as const;
export const REVIEW_INPUT_DIGEST_VERSION = 1 as const;
export interface ReviewSemanticVersions {
  reviewPolicy: number;
  resultContract: number;
  fingerprint: number;
  state: number;
}
export const REVIEW_SEMANTIC_VERSIONS: Readonly<ReviewSemanticVersions> = Object.freeze({
  reviewPolicy: 1,
  resultContract: 1,
  fingerprint: 1,
  state: REVIEW_STATE_VERSION,
});
export const MAX_REVIEW_STATE_ENCODED_BYTES = 24_576;
export const MAX_REVIEW_STATE_DECODED_BYTES = 18_432;
export const MAX_REVIEW_STATE_FINDINGS = 32;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;
const STATE_LINE_PATTERN = /^<!-- code-review-state:v(\d+):([A-Za-z0-9_-]+) -->$/u;

export type FindingLifecycleState = 'new' | 'unchanged' | 'resolved' | 'superseded';
export type ReviewMode = 'full' | 'incremental' | 'migration' | 'no-change';

export interface FindingFingerprint {
  anchorFingerprint: string;
  evidenceDigest: string;
  fingerprint: string;
}

export interface ReviewStateFinding extends FindingFingerprint {
  state: FindingLifecycleState;
  category: FindingCategory;
  severity: FindingSeverity;
  confidenceBasisPoints: number;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  firstSeenHeadSha: string;
  lastSeenHeadSha: string;
  supersededBy: string | null;
}

export interface ReviewStateV1 {
  version: typeof REVIEW_STATE_VERSION;
  apiUrl: string;
  repository: string;
  pullRequest: number;
  backend: ReviewBackend;
  actorId: number;
  baseSha: string;
  headSha: string;
  completedThroughHeadSha: string | null;
  generation: number;
  policyDigest: string;
  reviewInputDigest: string;
  publicationDigest: string;
  inlineHistorySuppressed: number;
  inlineLimitOmitted: number;
  coverageComplete: boolean;
  mode: ReviewMode;
  fromHeadSha: string | null;
  findings: ReviewStateFinding[];
}

export interface ReviewLifecycleCounts {
  new: number;
  unchanged: number;
  resolved: number;
  superseded: number;
}

export interface ReviewLifecycleResult {
  active: ReviewStateFinding[];
  tombstones: ReviewStateFinding[];
  counts: ReviewLifecycleCounts;
}

export type ParsedReviewState =
  { kind: 'valid'; state: ReviewStateV1; encoded: string } | { kind: 'none' | 'legacy' | 'malformed' | 'unsupported' };

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(JSON.stringify(value)).digest('base64url')}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  );
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateDepth(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.every((item) => validateDepth(item, depth + 1));
  const object = record(value);
  return !object || Object.values(object).every((item) => validateDepth(item, depth + 1));
}

function parseStateFinding(value: unknown): ReviewStateFinding | undefined {
  const object = record(value);
  const keys = [
    'fingerprint',
    'anchorFingerprint',
    'evidenceDigest',
    'state',
    'category',
    'severity',
    'confidenceBasisPoints',
    'path',
    'side',
    'line',
    'firstSeenHeadSha',
    'lastSeenHeadSha',
    'supersededBy',
  ];
  if (!object || !exactKeys(object, keys)) return undefined;
  if (!DIGEST_PATTERN.test(String(object.fingerprint)) || !DIGEST_PATTERN.test(String(object.anchorFingerprint))) {
    return undefined;
  }
  if (!DIGEST_PATTERN.test(String(object.evidenceDigest))) return undefined;
  if (!['new', 'unchanged', 'resolved', 'superseded'].includes(String(object.state))) return undefined;
  if (!['correctness', 'security', 'regression', 'testing'].includes(String(object.category))) return undefined;
  if (!['critical', 'high', 'medium', 'low'].includes(String(object.severity))) return undefined;
  if (
    !Number.isSafeInteger(object.confidenceBasisPoints) ||
    (object.confidenceBasisPoints as number) < 0 ||
    (object.confidenceBasisPoints as number) > 10_000
  )
    return undefined;
  if (!boundedString(object.path, 1_024) || /[\0\r\n]/u.test(object.path)) return undefined;
  if (object.side !== 'LEFT' && object.side !== 'RIGHT') return undefined;
  if (!safePositiveInteger(object.line)) return undefined;
  if (!SHA_PATTERN.test(String(object.firstSeenHeadSha)) || !SHA_PATTERN.test(String(object.lastSeenHeadSha)))
    return undefined;
  if (object.supersededBy !== null && !DIGEST_PATTERN.test(String(object.supersededBy))) return undefined;
  if (object.state === 'superseded' && object.supersededBy === null) return undefined;
  if (object.state !== 'superseded' && object.supersededBy !== null) return undefined;
  return {
    fingerprint: object.fingerprint as string,
    anchorFingerprint: object.anchorFingerprint as string,
    evidenceDigest: object.evidenceDigest as string,
    state: object.state as FindingLifecycleState,
    category: object.category as FindingCategory,
    severity: object.severity as FindingSeverity,
    confidenceBasisPoints: object.confidenceBasisPoints as number,
    path: object.path,
    side: object.side,
    line: object.line as number,
    firstSeenHeadSha: object.firstSeenHeadSha as string,
    lastSeenHeadSha: object.lastSeenHeadSha as string,
    supersededBy: object.supersededBy as string | null,
  };
}

function validateState(value: unknown): ReviewStateV1 | undefined {
  const object = record(value);
  const keys = [
    'version',
    'apiUrl',
    'repository',
    'pullRequest',
    'backend',
    'actorId',
    'baseSha',
    'headSha',
    'completedThroughHeadSha',
    'generation',
    'policyDigest',
    'reviewInputDigest',
    'publicationDigest',
    'inlineHistorySuppressed',
    'inlineLimitOmitted',
    'coverageComplete',
    'mode',
    'fromHeadSha',
    'findings',
  ];
  if (!object || !exactKeys(object, keys) || !validateDepth(object)) return undefined;
  if (object.version !== REVIEW_STATE_VERSION) return undefined;
  if (!boundedString(object.apiUrl, 2_048) || !boundedString(object.repository, 512)) return undefined;
  if (!safePositiveInteger(object.pullRequest) || (object.backend !== 'opencode' && object.backend !== 'pi'))
    return undefined;
  if (
    !safePositiveInteger(object.actorId) ||
    !SHA_PATTERN.test(String(object.baseSha)) ||
    !SHA_PATTERN.test(String(object.headSha))
  )
    return undefined;
  if (object.completedThroughHeadSha !== null && !SHA_PATTERN.test(String(object.completedThroughHeadSha)))
    return undefined;
  if (
    !safePositiveInteger(object.generation) ||
    !DIGEST_PATTERN.test(String(object.policyDigest)) ||
    !DIGEST_PATTERN.test(String(object.reviewInputDigest)) ||
    !DIGEST_PATTERN.test(String(object.publicationDigest))
  )
    return undefined;
  if (
    !Number.isSafeInteger(object.inlineHistorySuppressed) ||
    (object.inlineHistorySuppressed as number) < 0 ||
    (object.inlineHistorySuppressed as number) > 10 ||
    !Number.isSafeInteger(object.inlineLimitOmitted) ||
    (object.inlineLimitOmitted as number) < 0 ||
    (object.inlineLimitOmitted as number) > 10 ||
    (object.inlineHistorySuppressed as number) + (object.inlineLimitOmitted as number) > 10
  )
    return undefined;
  if (
    typeof object.coverageComplete !== 'boolean' ||
    !['full', 'incremental', 'migration', 'no-change'].includes(String(object.mode))
  )
    return undefined;
  if (object.fromHeadSha !== null && !SHA_PATTERN.test(String(object.fromHeadSha))) return undefined;
  if (!Array.isArray(object.findings) || object.findings.length > MAX_REVIEW_STATE_FINDINGS) return undefined;
  const findings = object.findings.map(parseStateFinding);
  if (findings.some((finding) => !finding)) return undefined;
  const validatedFindings = findings as ReviewStateFinding[];
  const fingerprints = new Set(validatedFindings.map((finding) => finding.fingerprint));
  if (fingerprints.size !== validatedFindings.length) return undefined;
  const active = validatedFindings.filter((finding) => finding.state === 'new' || finding.state === 'unchanged');
  const activeByFingerprint = new Map(active.map((finding) => [finding.fingerprint, finding]));
  if (new Set(active.map((finding) => finding.anchorFingerprint)).size !== active.length) return undefined;
  if (validatedFindings.some((finding) => finding.lastSeenHeadSha !== object.headSha)) return undefined;
  for (const finding of validatedFindings) {
    if (finding.state !== 'superseded') continue;
    const replacement = activeByFingerprint.get(finding.supersededBy as string);
    if (!replacement || replacement.anchorFingerprint !== finding.anchorFingerprint) return undefined;
  }
  if (object.coverageComplete && object.completedThroughHeadSha !== object.headSha) return undefined;
  const state: ReviewStateV1 = {
    version: REVIEW_STATE_VERSION,
    apiUrl: object.apiUrl,
    repository: object.repository,
    pullRequest: object.pullRequest as number,
    backend: object.backend,
    actorId: object.actorId as number,
    baseSha: object.baseSha as string,
    headSha: object.headSha as string,
    completedThroughHeadSha: object.completedThroughHeadSha as string | null,
    generation: object.generation as number,
    policyDigest: object.policyDigest as string,
    reviewInputDigest: object.reviewInputDigest as string,
    publicationDigest: object.publicationDigest as string,
    inlineHistorySuppressed: object.inlineHistorySuppressed as number,
    inlineLimitOmitted: object.inlineLimitOmitted as number,
    coverageComplete: object.coverageComplete,
    mode: object.mode as ReviewMode,
    fromHeadSha: object.fromHeadSha as string | null,
    findings: validatedFindings,
  };
  const expectedPublicationDigest = publicationDigest({
    repository: state.repository,
    pullRequest: state.pullRequest,
    backend: state.backend,
    actorId: state.actorId,
    headSha: state.headSha,
    fingerprints: active.map((finding) => finding.fingerprint),
  });
  return state.publicationDigest === expectedPublicationDigest ? state : undefined;
}

export function serializeReviewState(state: ReviewStateV1): string {
  const canonical = validateState(state);
  if (!canonical) throw new Error('Review state is invalid');
  const json = JSON.stringify(canonical);
  if (Buffer.byteLength(json, 'utf8') > MAX_REVIEW_STATE_DECODED_BYTES) {
    throw new Error('Review state exceeds metadata limit');
  }
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REVIEW_STATE_ENCODED_BYTES) {
    throw new Error('Review state exceeds metadata limit');
  }
  return `<!-- code-review-state:v1:${encoded} -->`;
}

export function parseReviewState(body: string | null, currentMarker: string): ParsedReviewState {
  if (typeof body !== 'string') return { kind: 'none' };
  const lines = body.trimEnd().split(/\r?\n/u);
  if (lines.at(-1) !== currentMarker) return { kind: 'legacy' };
  const stateLike = lines.filter((line) => line.startsWith('<!-- code-review-state:'));
  if (stateLike.length === 0) return { kind: 'malformed' };
  if (stateLike.length !== 1 || lines.at(-2) !== stateLike[0]) return { kind: 'malformed' };
  const match = STATE_LINE_PATTERN.exec(stateLike[0] ?? '');
  if (!match) return { kind: 'malformed' };
  if (match[1] !== String(REVIEW_STATE_VERSION)) return { kind: 'unsupported' };
  const encoded = match[2] as string;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REVIEW_STATE_ENCODED_BYTES) return { kind: 'malformed' };
  let json: string;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.length > MAX_REVIEW_STATE_DECODED_BYTES) return { kind: 'malformed' };
    json = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    return { kind: 'malformed' };
  }
  if (Buffer.from(json, 'utf8').toString('base64url') !== encoded) return { kind: 'malformed' };
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return { kind: 'malformed' };
  }
  const state = validateState(value);
  if (!state || JSON.stringify(state) !== json) return { kind: 'malformed' };
  return { kind: 'valid', state, encoded };
}

function normalizeExplanation(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim().replace(/\s+/gu, ' ');
}

function changedLine(
  file: UnifiedDiffFile,
  finding: Pick<ValidatedFinding, 'location'>,
): { line: UnifiedDiffLine; hunk: UnifiedDiffHunk } | undefined {
  const candidates: Array<{ line: UnifiedDiffLine; hunk: UnifiedDiffHunk }> = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (
        (finding.location.side === 'RIGHT' && line.kind === 'addition' && line.newLine === finding.location.line) ||
        (finding.location.side === 'LEFT' && line.kind === 'deletion' && line.oldLine === finding.location.line)
      )
        candidates.push({ line, hunk });
    }
  }
  if (candidates.length !== 1) return undefined;
  return candidates[0] as { line: UnifiedDiffLine; hunk: UnifiedDiffHunk };
}

function anchorSignature(file: UnifiedDiffFile, hunk: UnifiedDiffHunk, line: UnifiedDiffLine): readonly unknown[] {
  const index = hunk.lines.indexOf(line);
  const previous = [...hunk.lines.slice(0, index)].reverse().find((candidate) => candidate.kind === 'context');
  const next = hunk.lines.slice(index + 1).find((candidate) => candidate.kind === 'context');
  return [
    file.oldPath ?? file.newPath,
    line.kind,
    line.text,
    previous ? digest('code-review/context/v1', previous.text) : null,
    next ? digest('code-review/context/v1', next.text) : null,
  ];
}

export function anchorSignatureKey(file: UnifiedDiffFile, hunk: UnifiedDiffHunk, line: UnifiedDiffLine): string {
  return JSON.stringify(anchorSignature(file, hunk, line));
}

export function fingerprintAnchor(
  file: UnifiedDiffFile,
  hunk: UnifiedDiffHunk,
  line: UnifiedDiffLine,
  knownOrdinal?: number,
): { anchorFingerprint: string; evidenceDigest: string } {
  let ordinal = knownOrdinal;
  if (ordinal === undefined) {
    const signature = anchorSignatureKey(file, hunk, line);
    const equivalent = file.hunks.flatMap((candidateHunk) =>
      candidateHunk.lines
        .filter((candidateLine) => anchorSignatureKey(file, candidateHunk, candidateLine) === signature)
        .map((candidateLine) => ({ hunk: candidateHunk, line: candidateLine })),
    );
    ordinal = equivalent.findIndex((candidate) => candidate.hunk === hunk && candidate.line === line);
  }
  if (ordinal < 0) throw new Error('Changed-line anchor is not present in its file');
  return {
    anchorFingerprint: digest('code-review/anchor/v1', [...anchorSignature(file, hunk, line), ordinal]),
    evidenceDigest: digest('code-review/evidence/v1', line.text),
  };
}

export function fingerprintFinding(
  finding: Omit<ValidatedFinding, 'fingerprint' | 'anchorFingerprint' | 'evidenceDigest'>,
  diff: UnifiedDiff,
): FindingFingerprint {
  const files = diff.files.filter((file) => file.apiPath === finding.location.path && file.commentable);
  if (files.length !== 1) throw new Error('Validated finding file is ambiguous');
  const file = files[0] as UnifiedDiffFile;
  const selected = changedLine(file, finding);
  if (!selected) throw new Error('Validated finding anchor is ambiguous');
  const { anchorFingerprint, evidenceDigest } = fingerprintAnchor(file, selected.hunk, selected.line);
  return {
    anchorFingerprint,
    evidenceDigest,
    fingerprint: digest('code-review/finding/v1', [
      anchorFingerprint,
      finding.category,
      normalizeExplanation(finding.explanation),
    ]),
  };
}

export function publicationDigest(value: {
  repository: string;
  pullRequest: number;
  backend: ReviewBackend;
  actorId: number;
  headSha: string;
  fingerprints: readonly string[];
}): string {
  return digest('code-review/publication/v1', {
    ...value,
    fingerprints: [...value.fingerprints].sort(),
  });
}

export function reviewInputDigest(
  value: {
    policyDigest: string;
    pullRequest: { title: string; body: string; author: string };
    contextDigest: string;
    linkedIssues: readonly { number: number; digest: string }[];
  },
  semanticVersions: Readonly<ReviewSemanticVersions> = REVIEW_SEMANTIC_VERSIONS,
): string {
  return digest('code-review/review-input/v1', {
    version: REVIEW_INPUT_DIGEST_VERSION,
    semanticVersions,
    ...value,
    linkedIssues: [...value.linkedIssues].sort((left, right) => left.number - right.number),
  });
}

export function reviewPolicyDigest(value: {
  backend: ReviewBackend;
  model: string;
  modelApi: string;
  modelBaseUrl: string;
  modelNetwork: string;
  contextWindow: number;
  maximumOutputTokens: number;
  containerEngine: string;
  customPrompt: string;
  minimumConfidence: number;
  maximumInlineComments: number;
  maximumDiffBytes: number;
  indexer: string;
  opencodeVersion: string;
  piVersion: string;
}): string {
  return digest('code-review/policy/v1', value);
}

export interface ReviewStateIdentity {
  apiUrl: string;
  repository: string;
  pullRequest: number;
  backend: ReviewBackend;
  actorId: number;
  baseSha: string;
}

export function stateIdentityMatches(state: ReviewStateV1, expected: ReviewStateIdentity): boolean {
  return (
    state.apiUrl === expected.apiUrl &&
    state.repository === expected.repository &&
    state.pullRequest === expected.pullRequest &&
    state.backend === expected.backend &&
    state.actorId === expected.actorId &&
    state.baseSha === expected.baseSha
  );
}

export function stateScopeMatches(
  state: ReviewStateV1,
  expected: ReviewStateIdentity & { policyDigest: string; reviewInputDigest: string },
): boolean {
  return (
    stateIdentityMatches(state, expected) &&
    state.policyDigest === expected.policyDigest &&
    state.reviewInputDigest === expected.reviewInputDigest
  );
}

function stateRecord(finding: ValidatedFinding, headSha: string, previous?: ReviewStateFinding): ReviewStateFinding {
  return {
    fingerprint: finding.fingerprint,
    anchorFingerprint: finding.anchorFingerprint,
    evidenceDigest: finding.evidenceDigest,
    state: previous?.fingerprint === finding.fingerprint ? 'unchanged' : 'new',
    category: finding.category,
    severity: finding.severity,
    confidenceBasisPoints: Math.round(finding.confidence * 10_000),
    path: finding.location.path,
    side: finding.location.side,
    line: finding.location.line,
    firstSeenHeadSha: previous?.firstSeenHeadSha ?? headSha,
    lastSeenHeadSha: headSha,
    supersededBy: null,
  };
}

/** Reconciles a complete current finding set with one prior active generation. */
export function reconcileFindingStates(
  current: readonly ValidatedFinding[],
  prior: readonly ReviewStateFinding[],
  headSha: string,
  carried: readonly ReviewStateFinding[] = [],
): ReviewLifecycleResult {
  const priorActive = prior.filter((finding) => finding.state === 'new' || finding.state === 'unchanged');
  const byFingerprint = new Map(priorActive.map((finding) => [finding.fingerprint, finding]));
  const active = current.map((finding) => stateRecord(finding, headSha, byFingerprint.get(finding.fingerprint)));
  for (const item of carried) {
    if (!active.some((finding) => finding.fingerprint === item.fingerprint)) {
      active.push({ ...item, state: 'unchanged', lastSeenHeadSha: headSha, supersededBy: null });
    }
  }
  const currentFingerprints = new Set(active.map((finding) => finding.fingerprint));
  const currentAnchors = new Map(active.map((finding) => [finding.anchorFingerprint, finding]));
  const tombstones: ReviewStateFinding[] = [];
  for (const previous of priorActive) {
    if (currentFingerprints.has(previous.fingerprint)) continue;
    const replacement = currentAnchors.get(previous.anchorFingerprint);
    tombstones.push({
      ...previous,
      state: replacement ? 'superseded' : 'resolved',
      lastSeenHeadSha: headSha,
      supersededBy: replacement?.fingerprint ?? null,
    });
  }
  const counts = {
    new: active.filter((finding) => finding.state === 'new').length,
    unchanged: active.filter((finding) => finding.state === 'unchanged').length,
    resolved: tombstones.filter((finding) => finding.state === 'resolved').length,
    superseded: tombstones.filter((finding) => finding.state === 'superseded').length,
  };
  return { active, tombstones, counts };
}

export function bodyDigest(body: string): string {
  return digest('code-review/comment-body/v1', body);
}
