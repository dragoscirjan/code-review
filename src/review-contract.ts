import { encodedModelTextBytes } from './review-text';

export const REVIEW_RESULT_VERSION = 1 as const;
export const MAX_REVIEW_RESULT_BYTES = 60_000;
/** Version of the bounded incremental emission protocol appended to shard prompts. */
export const SHARD_EMISSION_PROTOCOL_VERSION = 1 as const;
/** Maximum number of increment documents one shard output may contain. */
export const MAX_SHARD_EMISSION_LINES = 32;
export const MAX_JSON_NESTING_DEPTH = 32;
// Reserves 10,536 bytes for deterministic labels and bounded action metadata under GitHub's 65,536-byte limit.
export const MAX_RENDERED_MODEL_TEXT_BYTES = 55_000;
export const MAX_FINDINGS = 10;
export const MAX_PATH_BYTES = 1_024;
export const MAX_EVIDENCE_BYTES = 1_000;
export const MAX_EXPLANATION_BYTES = 1_000;
export const MAX_SUGGESTED_FIX_BYTES = 2_000;
export const SUGGESTION_FIX_PREFIX = 'suggestion:\n';

export const FINDING_CATEGORIES = ['correctness', 'security', 'regression', 'testing'] as const;
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const DIFF_SIDES = ['LEFT', 'RIGHT'] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type DiffSide = (typeof DIFF_SIDES)[number];
export type FindingConfidence = number;
export type FindingEvidence = string;
export type SuggestedFix = string;

export interface FindingLocation {
  path: string;
  side: DiffSide;
  line: number;
}

export interface ReviewFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  location: FindingLocation;
  evidence: FindingEvidence;
  explanation: string;
  fix: SuggestedFix;
}

export type ReviewResultV1 =
  | {
      version: typeof REVIEW_RESULT_VERSION;
      outcome: 'clean';
      findings: [];
    }
  | {
      version: typeof REVIEW_RESULT_VERSION;
      outcome: 'findings';
      findings: [ReviewFinding, ...ReviewFinding[]];
    };

export type ReviewContractErrorCode =
  | 'duplicate-property'
  | 'invalid-field'
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-version'
  | 'nesting-too-deep'
  | 'oversized-output';

const ERROR_MESSAGES: Record<ReviewContractErrorCode, string> = {
  'duplicate-property': 'Review result contains a duplicate property',
  'invalid-field': 'Review result contains an invalid field value',
  'invalid-json': 'Review result is not one valid JSON document',
  'invalid-shape': 'Review result does not match the required contract shape',
  'invalid-version': 'Review result uses an unsupported contract version',
  'nesting-too-deep': 'Review result exceeds the JSON nesting limit',
  'oversized-output': 'Review result exceeds a contract size limit',
};

export class ReviewContractError extends Error {
  constructor(readonly code: ReviewContractErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ReviewContractError';
  }
}

function fail(code: ReviewContractErrorCode): never {
  throw new ReviewContractError(code);
}

/** Validates JSON syntax while retaining object keys so duplicates cannot be hidden by JSON.parse. */
class DuplicateAwareJsonScanner {
  private offset = 0;

  constructor(private readonly input: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.offset !== this.input.length) fail('invalid-json');
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.input[this.offset] ?? '') && /[\t\n\r ]/.test(this.input[this.offset] ?? '')) {
      this.offset += 1;
    }
  }

  private scanValue(depth: number): void {
    const value = this.input[this.offset];
    if (value === '{') {
      if (depth >= MAX_JSON_NESTING_DEPTH) fail('nesting-too-deep');
      this.scanObject(depth + 1);
    } else if (value === '[') {
      if (depth >= MAX_JSON_NESTING_DEPTH) fail('nesting-too-deep');
      this.scanArray(depth + 1);
    } else if (value === '"') this.scanString();
    else if (value === '-' || (value !== undefined && value >= '0' && value <= '9')) this.scanNumber();
    else if (this.input.startsWith('true', this.offset)) this.offset += 4;
    else if (this.input.startsWith('false', this.offset)) this.offset += 5;
    else if (this.input.startsWith('null', this.offset)) this.offset += 4;
    else fail('invalid-json');
  }

  private scanObject(depth: number): void {
    this.offset += 1;
    this.skipWhitespace();
    if (this.input[this.offset] === '}') {
      this.offset += 1;
      return;
    }

    const keys = new Set<string>();
    while (true) {
      if (this.input[this.offset] !== '"') fail('invalid-json');
      const key = this.scanString();
      if (keys.has(key)) fail('duplicate-property');
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.offset] !== ':') fail('invalid-json');
      this.offset += 1;
      this.skipWhitespace();
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.input[this.offset] === '}') {
        this.offset += 1;
        return;
      }
      if (this.input[this.offset] !== ',') fail('invalid-json');
      this.offset += 1;
      this.skipWhitespace();
    }
  }

  private scanArray(depth: number): void {
    this.offset += 1;
    this.skipWhitespace();
    if (this.input[this.offset] === ']') {
      this.offset += 1;
      return;
    }
    while (true) {
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.input[this.offset] === ']') {
        this.offset += 1;
        return;
      }
      if (this.input[this.offset] !== ',') fail('invalid-json');
      this.offset += 1;
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.input.length) {
      const character = this.input[this.offset];
      if (character === '"') {
        this.offset += 1;
        try {
          return JSON.parse(this.input.slice(start, this.offset)) as string;
        } catch {
          return fail('invalid-json');
        }
      }
      if (character === '\\') {
        this.offset += 1;
        const escape = this.input[this.offset];
        if (escape === 'u') {
          const hexadecimal = this.input.slice(this.offset + 1, this.offset + 5);
          if (!/^[\da-fA-F]{4}$/.test(hexadecimal)) fail('invalid-json');
          this.offset += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) fail('invalid-json');
        this.offset += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) fail('invalid-json');
      this.offset += 1;
    }
    return fail('invalid-json');
  }

  private scanNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.input.slice(this.offset));
    if (!match) fail('invalid-json');
    this.offset += match[0].length;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasDisallowedProseControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

function validBoundedString(value: unknown, maximumBytes: number, path: boolean): value is string {
  if (typeof value !== 'string' || !isWellFormed(value) || !value.trim()) return false;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes === 0 || bytes > maximumBytes) return false;
  return path
    ? !value.includes('\0') && !value.includes('\r') && !value.includes('\n')
    : !hasDisallowedProseControl(value);
}

function parseLocation(value: unknown): FindingLocation {
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'side', 'line'])) fail('invalid-shape');
  if (!validBoundedString(value.path, MAX_PATH_BYTES, true)) {
    if (typeof value.path === 'string' && Buffer.byteLength(value.path, 'utf8') > MAX_PATH_BYTES) {
      fail('oversized-output');
    }
    fail('invalid-field');
  }
  if (!DIFF_SIDES.includes(value.side as DiffSide)) fail('invalid-field');
  if (!Number.isSafeInteger(value.line) || (value.line as number) <= 0) fail('invalid-field');
  return { path: value.path, side: value.side as DiffSide, line: value.line as number };
}

function parseFinding(value: unknown): ReviewFinding {
  const keys = ['category', 'severity', 'confidence', 'location', 'evidence', 'explanation', 'fix'];
  if (!isRecord(value) || !hasExactKeys(value, keys)) fail('invalid-shape');
  if (!FINDING_CATEGORIES.includes(value.category as FindingCategory)) fail('invalid-field');
  if (!FINDING_SEVERITIES.includes(value.severity as FindingSeverity)) fail('invalid-field');
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    fail('invalid-field');
  }

  const boundedProse = [
    [value.evidence, MAX_EVIDENCE_BYTES],
    [value.explanation, MAX_EXPLANATION_BYTES],
    [value.fix, MAX_SUGGESTED_FIX_BYTES],
  ] as const;
  for (const [field, maximumBytes] of boundedProse) {
    if (!validBoundedString(field, maximumBytes, false)) {
      if (typeof field === 'string' && Buffer.byteLength(field, 'utf8') > maximumBytes) fail('oversized-output');
      fail('invalid-field');
    }
  }

  return {
    category: value.category as FindingCategory,
    severity: value.severity as FindingSeverity,
    confidence: value.confidence,
    location: parseLocation(value.location),
    evidence: value.evidence as string,
    explanation: value.explanation as string,
    fix: value.fix as string,
  };
}

export function parseReviewResult(raw: string): ReviewResultV1 {
  if (Buffer.byteLength(raw, 'utf8') > MAX_REVIEW_RESULT_BYTES) fail('oversized-output');
  new DuplicateAwareJsonScanner(raw).scan();

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return fail('invalid-json');
  }
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'outcome', 'findings'])) fail('invalid-shape');
  if (value.version !== REVIEW_RESULT_VERSION) fail('invalid-version');
  if (value.outcome !== 'clean' && value.outcome !== 'findings') fail('invalid-field');
  if (!Array.isArray(value.findings)) fail('invalid-shape');
  if (value.findings.length > MAX_FINDINGS) fail('oversized-output');
  if ((value.outcome === 'clean') !== (value.findings.length === 0)) fail('invalid-field');

  const findings = value.findings.map(parseFinding);
  const renderedModelTextBytes = findings.reduce(
    (total, finding) =>
      total +
      encodedModelTextBytes(finding.location.path) +
      encodedModelTextBytes(finding.evidence) +
      encodedModelTextBytes(finding.explanation) +
      encodedModelTextBytes(finding.fix),
    0,
  );
  if (renderedModelTextBytes > MAX_RENDERED_MODEL_TEXT_BYTES) fail('oversized-output');
  if (value.outcome === 'clean') return { version: REVIEW_RESULT_VERSION, outcome: 'clean', findings: [] };
  return {
    version: REVIEW_RESULT_VERSION,
    outcome: 'findings',
    findings: findings as [ReviewFinding, ...ReviewFinding[]],
  };
}

export interface ParsedShardReviewOutput {
  review: ReviewResultV1;
  /** Increment lines that failed strict contract parsing; a malformed tail degrades the shard. */
  malformedIncrements: number;
}

/**
 * Parses one shard's backend output under the incremental emission protocol v1. A single complete
 * v1 document is accepted unchanged. Otherwise the output is parsed line by line: every complete
 * v1 document on its own line is a valid increment whose findings accumulate, and lines that fail
 * strict parsing are counted as malformed increments instead of discarding earlier valid ones.
 * When every line fails, the output is malformed as a whole and the shard degrades as before.
 */
export function parseShardReviewOutput(raw: string): ParsedShardReviewOutput {
  try {
    return { review: parseReviewResult(raw), malformedIncrements: 0 };
  } catch (error) {
    if (!(error instanceof ReviewContractError)) throw error;
  }
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_SHARD_EMISSION_LINES) fail('invalid-shape');
  const findings: ReviewFinding[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      findings.push(...parseReviewResult(line).findings);
    } catch (error) {
      if (!(error instanceof ReviewContractError)) throw error;
      malformed += 1;
    }
  }
  if (malformed === lines.length) fail('invalid-json');
  return {
    review:
      findings.length === 0
        ? { version: REVIEW_RESULT_VERSION, outcome: 'clean', findings: [] }
        : {
            version: REVIEW_RESULT_VERSION,
            outcome: 'findings',
            findings: findings as [ReviewFinding, ...ReviewFinding[]],
          },
    malformedIncrements: malformed,
  };
}
