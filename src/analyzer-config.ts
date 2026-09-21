import { createHash } from 'node:crypto';
import type { GitHubClient, PullRequestContext } from './github';
import { parseStrictJson } from './strict-json';

export const ANALYZER_CONFIG_PATH = '.github/code-review-analyzers.json';
export const MAX_ANALYZER_CONFIG_BYTES = 16_384;
export const ANALYZER_CONFIG_VERSION = 1 as const;
export const ANALYZER_CONTRACT_VERSION = 1 as const;

export type DeterministicAnalyzerMode = 'none' | 'base-config';
export const ANALYZER_IDS = ['conflict-markers', 'typescript-syntax', 'json-syntax'] as const;
export type AnalyzerId = (typeof ANALYZER_IDS)[number];
export const ANALYZER_RULES = {
  'conflict-markers': ['unresolved-conflict-marker'],
  'typescript-syntax': ['syntax-error'],
  'json-syntax': ['syntax-error', 'duplicate-property'],
} as const;
export type AnalyzerRuleId =
  | (typeof ANALYZER_RULES)['conflict-markers'][number]
  | (typeof ANALYZER_RULES)['typescript-syntax'][number]
  | (typeof ANALYZER_RULES)['json-syntax'][number];

export const ANALYZER_VERSIONS: Readonly<Record<AnalyzerId, string>> = Object.freeze({
  'conflict-markers': 'code-review-conflict@1.0.0',
  'typescript-syntax': 'typescript@5.9.3-syntax',
  'json-syntax': 'code-review-json@1.0.0',
});

export const ANALYZER_RULE_REVISIONS: Readonly<Record<AnalyzerRuleId, number>> = Object.freeze({
  'unresolved-conflict-marker': 1,
  'syntax-error': 1,
  'duplicate-property': 1,
});

export interface AnalyzerLimits {
  maximumFiles: number;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  maximumObservations: number;
  timeoutSeconds: number;
  contextBytes: number;
}

export const DEFAULT_ANALYZER_LIMITS: Readonly<AnalyzerLimits> = Object.freeze({
  maximumFiles: 32,
  maximumFileBytes: 262_144,
  maximumTotalBytes: 4_194_304,
  maximumObservations: 50,
  timeoutSeconds: 30,
  contextBytes: 12_000,
});

export const MAXIMUM_ANALYZER_LIMITS: Readonly<AnalyzerLimits> = Object.freeze({
  maximumFiles: 64,
  maximumFileBytes: 524_288,
  maximumTotalBytes: 8_388_608,
  maximumObservations: 100,
  timeoutSeconds: 60,
  contextBytes: 12_000,
});

export interface EnabledAnalyzer {
  id: AnalyzerId;
  rules: AnalyzerRuleId[];
}

export interface AnalyzerConfiguration {
  mode: DeterministicAnalyzerMode;
  status: 'disabled' | 'missing' | 'enabled';
  baseSha: string;
  blobSha?: string;
  analyzers: EnabledAnalyzer[];
  limits: AnalyzerLimits;
  configDigest: string;
  manifestDigest: string;
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(JSON.stringify(value)).digest('base64url')}`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Analyzer configuration must contain JSON objects');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
    throw new Error('Analyzer configuration contains unknown or missing fields');
  }
}

function boundedInteger(value: unknown, name: keyof AnalyzerLimits): number {
  // Repository policy may only tighten the action-owned defaults, never expand analyzer capability.
  const maximum = DEFAULT_ANALYZER_LIMITS[name];
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`Analyzer limit ${name} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function canonicalManifest(configuration: Omit<AnalyzerConfiguration, 'configDigest' | 'manifestDigest'>) {
  return {
    contractVersion: ANALYZER_CONTRACT_VERSION,
    mode: configuration.mode,
    status: configuration.status,
    baseSha: configuration.baseSha,
    blobSha: configuration.blobSha ?? null,
    analyzers: configuration.analyzers.map((entry) => ({
      id: entry.id,
      version: ANALYZER_VERSIONS[entry.id],
      rules: entry.rules.map((ruleId) => ({ ruleId, revision: ANALYZER_RULE_REVISIONS[ruleId] })),
    })),
    limits: configuration.limits,
  };
}

function finalize(
  configuration: Omit<AnalyzerConfiguration, 'configDigest' | 'manifestDigest'>,
): AnalyzerConfiguration {
  const canonicalConfig = {
    version: ANALYZER_CONFIG_VERSION,
    analyzers: configuration.analyzers,
    limits: configuration.limits,
  };
  const configDigest = digest('code-review/analyzer-config/v1', canonicalConfig);
  return {
    ...configuration,
    configDigest,
    manifestDigest: digest('code-review/analyzer-manifest/v1', {
      ...canonicalManifest(configuration),
      configDigest,
    }),
  };
}

export function disabledAnalyzerConfiguration(baseSha: string): AnalyzerConfiguration {
  return finalize({
    mode: 'none',
    status: 'disabled',
    baseSha,
    analyzers: [],
    limits: { ...DEFAULT_ANALYZER_LIMITS },
  });
}

export function parseAnalyzerConfiguration(raw: string, baseSha: string, blobSha?: string): AnalyzerConfiguration {
  const root = record(parseStrictJson(raw, MAX_ANALYZER_CONFIG_BYTES));
  exactKeys(root, ['version', 'analyzers', 'limits']);
  if (root.version !== ANALYZER_CONFIG_VERSION) throw new Error('Analyzer configuration version must be 1');
  if (!Array.isArray(root.analyzers) || root.analyzers.length > ANALYZER_IDS.length) {
    throw new Error('Analyzer configuration has too many analyzers');
  }
  const seenAnalyzers = new Set<AnalyzerId>();
  const analyzers: EnabledAnalyzer[] = [];
  for (const rawAnalyzer of root.analyzers) {
    const analyzer = record(rawAnalyzer);
    exactKeys(analyzer, ['id', 'rules']);
    if (!ANALYZER_IDS.includes(analyzer.id as AnalyzerId)) throw new Error('Unknown deterministic analyzer');
    const id = analyzer.id as AnalyzerId;
    if (seenAnalyzers.has(id)) throw new Error('Duplicate deterministic analyzer');
    seenAnalyzers.add(id);
    if (!Array.isArray(analyzer.rules) || analyzer.rules.length === 0) {
      throw new Error('Analyzer rules must be a nonempty array');
    }
    const allowed = ANALYZER_RULES[id] as readonly string[];
    const seenRules = new Set<string>();
    const rules: AnalyzerRuleId[] = [];
    for (const rule of analyzer.rules) {
      if (typeof rule !== 'string' || !allowed.includes(rule)) throw new Error('Unknown analyzer rule');
      if (seenRules.has(rule)) throw new Error('Duplicate analyzer rule');
      seenRules.add(rule);
      rules.push(rule as AnalyzerRuleId);
    }
    rules.sort((left, right) => allowed.indexOf(left) - allowed.indexOf(right));
    analyzers.push({ id, rules });
  }
  analyzers.sort((left, right) => ANALYZER_IDS.indexOf(left.id) - ANALYZER_IDS.indexOf(right.id));

  const limitsObject = record(root.limits);
  const limitKeys = [
    'maximumFiles',
    'maximumFileBytes',
    'maximumTotalBytes',
    'maximumObservations',
    'timeoutSeconds',
    'contextBytes',
  ] as const;
  exactKeys(limitsObject, limitKeys);
  const limits = Object.fromEntries(
    limitKeys.map((name) => [name, boundedInteger(limitsObject[name], name)]),
  ) as unknown as AnalyzerLimits;
  if (limits.maximumFileBytes > limits.maximumTotalBytes) {
    throw new Error('Analyzer maximumFileBytes cannot exceed maximumTotalBytes');
  }
  return finalize({ mode: 'base-config', status: 'enabled', baseSha, blobSha, analyzers, limits });
}

export async function loadAnalyzerConfiguration(input: {
  client: Pick<GitHubClient, 'getRepositoryTextAtRevision'>;
  pullRequest: PullRequestContext;
  mode: DeterministicAnalyzerMode;
}): Promise<AnalyzerConfiguration> {
  if (input.mode === 'none') return disabledAnalyzerConfiguration(input.pullRequest.baseSha);
  const result = await input.client.getRepositoryTextAtRevision(
    input.pullRequest,
    ANALYZER_CONFIG_PATH,
    input.pullRequest.baseSha,
    MAX_ANALYZER_CONFIG_BYTES,
    AbortSignal.timeout(10_000),
  );
  if (result.status === 'not-found') {
    return finalize({
      mode: 'base-config',
      status: 'missing',
      baseSha: input.pullRequest.baseSha,
      analyzers: [],
      limits: { ...DEFAULT_ANALYZER_LIMITS },
    });
  }
  if (result.status !== 'found' || result.truncated || result.text === undefined || !result.blobSha) {
    throw new Error('Analyzer configuration is unavailable or exceeds the limit');
  }
  return parseAnalyzerConfiguration(result.text, input.pullRequest.baseSha, result.blobSha);
}
