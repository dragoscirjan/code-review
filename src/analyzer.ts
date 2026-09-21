import { createHash } from 'node:crypto';
import { extname } from 'node:path/posix';
import ts from 'typescript';
import {
  ANALYZER_RULE_REVISIONS,
  ANALYZER_VERSIONS,
  type AnalyzerConfiguration,
  type AnalyzerId,
  type AnalyzerRuleId,
} from './analyzer-config';
import {
  analyzerReportSerializedBytes,
  createAnalyzerReport,
  isAnalyzerEvidence,
  isAnalyzerMessage,
  isAnalyzerObservationPath,
  MAX_ANALYZER_OUT_OF_SCOPE_OBSERVATIONS,
  MAX_ANALYZER_REPORT_BYTES,
  observationDigest,
  type AnalyzerFindingCandidate,
  type AnalyzerObservationV1,
  type AnalyzerReportV1,
  type AnalyzerRunV1,
} from './analyzer-contract';
import { truncateUtf8, type ReviewContextItem } from './context-planner';
import type { GitHubClient, PullRequestContext, PullRequestDiff, RepositoryTextResult } from './github';
import { StrictJsonError, parseStrictJson } from './strict-json';
import type { UnifiedDiffFile, UnifiedDiffLine } from './unified-diff';

const MAX_SOURCE_LINE_BYTES = 65_536;
const ANALYZER_FETCH_TIMEOUT_MS = 10_000;
const TYPESCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const JSON_EXTENSIONS = new Set(['.json']);
const TEXT_EXTENSIONS = new Set([
  ...TYPESCRIPT_EXTENSIONS,
  ...JSON_EXTENSIONS,
  '.py',
  '.pyi',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hh',
  '.hpp',
  '.php',
  '.rb',
  '.yaml',
  '.yml',
  '.toml',
]);
const EXCLUDED_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
]);

interface AcquiredFile {
  path: string;
  opaqueId: string;
  text: string;
  lines: string[];
  bytes: number;
  blobSha: string;
  file: UnifiedDiffFile;
}

interface RawDiagnostic {
  ruleId: AnalyzerRuleId;
  line: number;
  column: number;
  message: string;
}

interface DiagnosticBatch {
  diagnostics: RawDiagnostic[];
  generationTruncated: boolean;
  resourceLimited: boolean;
}

export interface AnalyzerSummary {
  mode: AnalyzerConfiguration['mode'];
  configStatus: AnalyzerConfiguration['status'];
  manifestDigest: string;
  inputDigest: string;
  resultDigest: string;
  coverage: 'complete' | 'partial';
  runCount: number;
  acceptedObservations: number;
  skippedFiles: number;
  outOfScopeObservations: number;
  contextTruncated: boolean;
  unavailableSourceCount: number;
  runs: Array<{
    analyzer: AnalyzerId;
    analyzerVersion: string;
    status: 'complete' | 'partial';
    analyzedFiles: number;
    skippedFiles: number;
    acceptedObservations: number;
  }>;
}

export interface DeterministicAnalysis {
  report: AnalyzerReportV1;
  findings: AnalyzerFindingCandidate[];
  contextItems: ReviewContextItem[];
  summary: AnalyzerSummary;
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(JSON.stringify(value)).digest('base64url')}`;
}

function normalizedLines(value: string): string[] {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
}

function analyzerSupports(id: AnalyzerId, path: string): boolean {
  if (EXCLUDED_BASENAMES.has(path.split('/').at(-1) ?? '')) return false;
  const extension = extname(path).toLowerCase();
  if (id === 'typescript-syntax') return TYPESCRIPT_EXTENSIONS.has(extension);
  if (id === 'json-syntax') return JSON_EXTENSIONS.has(extension);
  return TEXT_EXTENSIONS.has(extension);
}

function changedAddition(file: UnifiedDiffFile, line: number): UnifiedDiffLine | undefined {
  const matches = file.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((candidate) => candidate.kind === 'addition' && candidate.newLine === line);
  return matches.length === 1 ? matches[0] : undefined;
}

function offsetLocation(text: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const prefix = text.slice(0, safeOffset).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = prefix.split('\n');
  return { line: lines.length, column: [...(lines.at(-1) ?? '')].length + 1 };
}

function sanitizeMessage(value: string): string {
  let visible = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    const code = character.charCodeAt(0);
    if (code === 0x1b && value[index + 1] === '[') {
      index += 2;
      while (index < value.length) {
        const escapeCode = value.charCodeAt(index);
        if (escapeCode >= 0x40 && escapeCode <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    visible += (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f ? ' ' : character;
  }
  visible = visible.replace(/::/gu, ':\u200B:').trim();
  return truncateUtf8(visible || 'Analyzer reported invalid syntax.', 512).value;
}

function conflictDiagnostics(
  file: AcquiredFile,
  rules: readonly AnalyzerRuleId[],
  maximumDiagnostics: number,
): DiagnosticBatch {
  if (!rules.includes('unresolved-conflict-marker')) {
    return { diagnostics: [], generationTruncated: false, resourceLimited: false };
  }
  const diagnostics: RawDiagnostic[] = [];
  for (let index = 0; index < file.lines.length; index += 1) {
    const line = file.lines[index] as string;
    if (!/^(?:<{7}(?: .*)?|={7}|>{7}(?: .*)?)$/u.test(line)) continue;
    if (diagnostics.length >= maximumDiagnostics) {
      return { diagnostics, generationTruncated: true, resourceLimited: false };
    }
    diagnostics.push({
      ruleId: 'unresolved-conflict-marker',
      line: index + 1,
      column: 1,
      message: 'Unresolved merge-conflict marker.',
    });
  }
  return { diagnostics, generationTruncated: false, resourceLimited: false };
}

function typescriptDiagnostics(
  file: AcquiredFile,
  rules: readonly AnalyzerRuleId[],
  maximumDiagnostics: number,
): DiagnosticBatch {
  if (!rules.includes('syntax-error')) {
    return { diagnostics: [], generationTruncated: false, resourceLimited: false };
  }
  const extension = extname(file.path).toLowerCase();
  const jsx = extension === '.jsx' || extension === '.tsx';
  const fileName = `${file.opaqueId}${extension}`;
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: jsx ? ts.JsxEmit.Preserve : undefined,
  };
  const source = ts.createSourceFile(
    fileName,
    file.text,
    ts.ScriptTarget.ES2022,
    true,
    jsx ? ts.ScriptKind.TSX : extension.includes('js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const host: ts.CompilerHost = {
    getSourceFile: (requested) => (requested === fileName ? source : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    fileExists: (requested) => requested === fileName,
    readFile: (requested) => (requested === fileName ? file.text : undefined),
    getCanonicalFileName: (requested) => requested,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const diagnostics = ts.createProgram([fileName], compilerOptions, host).getSyntacticDiagnostics(source);
  const normalized = diagnostics.slice(0, maximumDiagnostics).flatMap((diagnostic) => {
    if (diagnostic.category !== ts.DiagnosticCategory.Error || diagnostic.start === undefined) return [];
    const location = source.getLineAndCharacterOfPosition(Math.min(diagnostic.start, file.text.length));
    return [
      {
        ruleId: 'syntax-error' as const,
        line: location.line + 1,
        column: location.character + 1,
        message: sanitizeMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')),
      },
    ];
  });
  return {
    diagnostics: normalized,
    generationTruncated: diagnostics.length > maximumDiagnostics,
    resourceLimited: false,
  };
}

function jsonDiagnostics(file: AcquiredFile, rules: readonly AnalyzerRuleId[]): DiagnosticBatch {
  try {
    parseStrictJson(file.text, file.bytes, 32);
    return { diagnostics: [], generationTruncated: false, resourceLimited: false };
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    if (error.code !== 'invalid-json' && error.code !== 'duplicate-property') {
      return { diagnostics: [], generationTruncated: false, resourceLimited: true };
    }
    const ruleId: AnalyzerRuleId = error.code === 'duplicate-property' ? 'duplicate-property' : 'syntax-error';
    if (!rules.includes(ruleId)) return { diagnostics: [], generationTruncated: false, resourceLimited: false };
    const location = offsetLocation(file.text, error.offset);
    return {
      diagnostics: [
        {
          ruleId,
          ...location,
          message: ruleId === 'duplicate-property' ? 'Duplicate JSON property.' : 'Invalid strict JSON syntax.',
        },
      ],
      generationTruncated: false,
      resourceLimited: false,
    };
  }
}

function rawDiagnostics(
  id: AnalyzerId,
  file: AcquiredFile,
  rules: readonly AnalyzerRuleId[],
  maximumDiagnostics: number,
): DiagnosticBatch {
  if (id === 'typescript-syntax') return typescriptDiagnostics(file, rules, maximumDiagnostics);
  if (id === 'json-syntax') return jsonDiagnostics(file, rules);
  return conflictDiagnostics(file, rules, maximumDiagnostics);
}

function containsSecret(value: string, secrets: readonly string[]): boolean {
  return [...new Set(secrets)].filter(Boolean).some((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return value.includes(secret) || (escaped !== secret && value.includes(escaped));
  });
}

function ruleFinding(
  analyzer: AnalyzerId,
  analyzerVersion: string,
  observation: AnalyzerObservationV1,
): AnalyzerFindingCandidate {
  const common = {
    category: 'correctness' as const,
    confidence: 1,
    location: { path: observation.path, side: 'RIGHT' as const, line: observation.line },
    evidence: observation.evidence,
    origin: {
      kind: 'analyzer' as const,
      analyzer,
      analyzerVersion,
      ruleId: observation.ruleId,
      ruleRevision: ANALYZER_RULE_REVISIONS[observation.ruleId],
      observationDigest: observation.digest,
    },
  };
  if (observation.ruleId === 'unresolved-conflict-marker') {
    return {
      ...common,
      severity: 'critical',
      explanation: 'The changed line contains an unresolved merge-conflict marker and cannot be valid merged source.',
      fix: 'Resolve the conflict and remove all conflict marker lines.',
    };
  }
  if (observation.ruleId === 'duplicate-property') {
    return {
      ...common,
      severity: 'high',
      explanation:
        'The changed JSON declares the same property more than once, so consumers can disagree about its value.',
      fix: 'Keep one uniquely named property with the intended value.',
    };
  }
  return {
    ...common,
    severity: 'high',
    explanation: 'The changed line is part of a file that the fixed syntax parser cannot parse.',
    fix: 'Correct the syntax while preserving the intended behavior.',
  };
}

function contextItems(
  report: AnalyzerReportV1,
  configuration: AnalyzerConfiguration,
  headSha: string,
): {
  items: ReviewContextItem[];
  truncated: boolean;
} {
  if (report.runs.length === 0) return { items: [], truncated: false };
  const serialized = JSON.stringify(report);
  const limited = truncateUtf8(serialized, configuration.limits.contextBytes);
  const truncated = limited.truncated || report.coverage === 'partial';
  return {
    truncated,
    items: [
      {
        source: {
          source: 'deterministic-analysis',
          sourceId: 'analyzer-report:v1',
          revision: headSha,
          status: truncated ? 'truncated' : 'included',
          acquiredBytes: Buffer.byteLength(serialized, 'utf8'),
          includedBytes: 0,
          contentDigest: report.resultDigest,
          ...(report.coverage === 'partial' ? { reason: 'partial-coverage' } : {}),
        },
        content: limited.value,
      },
    ],
  };
}

function createBoundedAnalyzerReport(
  inputDigest: string,
  runs: AnalyzerRunV1[],
  forcePartial: boolean,
): AnalyzerReportV1 {
  let coverage: 'complete' | 'partial' =
    forcePartial || runs.some((run) => run.status === 'partial') ? 'partial' : 'complete';
  while (analyzerReportSerializedBytes({ inputDigest, coverage, runs }) > MAX_ANALYZER_REPORT_BYTES) {
    const run = [...runs].reverse().find((candidate) => candidate.observations.length > 0);
    if (!run) throw new Error('Fixed analyzer report metadata exceeds its byte budget');
    run.observations.pop();
    run.status = 'partial';
    coverage = 'partial';
  }
  return createAnalyzerReport({ inputDigest, coverage, runs });
}

/** Runs fixed in-process parsers over bounded exact-head text; no child process, repository executable, or config is loaded. */
export async function runDeterministicAnalysis(input: {
  client: Pick<GitHubClient, 'getRepositoryTextAtRevision'>;
  pullRequest: PullRequestContext;
  diff: PullRequestDiff & Required<Pick<PullRequestDiff, 'parsed'>>;
  configuration: AnalyzerConfiguration;
  secrets?: readonly string[];
  assertFresh?: () => Promise<void>;
  now?: () => number;
}): Promise<DeterministicAnalysis> {
  const now = input.now ?? Date.now;
  const start = now();
  const deadline = start + input.configuration.limits.timeoutSeconds * 1_000;
  const remainingMilliseconds = () => deadline - now();
  await input.assertFresh?.();
  const eligiblePaths = new Map<string, UnifiedDiffFile>();
  for (const file of input.diff.parsed.files) {
    if (file.commentable && file.newPath) eligiblePaths.set(file.newPath, file);
  }
  const requiredPaths = [...eligiblePaths.entries()]
    .filter(([path]) => input.configuration.analyzers.some((entry) => analyzerSupports(entry.id, path)))
    .sort(([left], [right]) => left.localeCompare(right, 'en'));

  const selected = requiredPaths.slice(0, input.configuration.limits.maximumFiles);
  let acquisitionPartial = input.diff.truncated || requiredPaths.length > selected.length;
  let totalBytes = 0;
  const files: AcquiredFile[] = [];
  for (const [path, file] of selected) {
    if (!isAnalyzerObservationPath(path)) {
      acquisitionPartial = true;
      continue;
    }
    const remainingBeforeFetch = remainingMilliseconds();
    if (remainingBeforeFetch <= 0) {
      acquisitionPartial = true;
      break;
    }
    let result: RepositoryTextResult;
    try {
      result = await input.client.getRepositoryTextAtRevision(
        input.pullRequest,
        path,
        input.pullRequest.headSha,
        input.configuration.limits.maximumFileBytes,
        AbortSignal.timeout(Math.max(1, Math.min(ANALYZER_FETCH_TIMEOUT_MS, Math.floor(remainingBeforeFetch)))),
      );
    } catch {
      acquisitionPartial = true;
      continue;
    }
    if (remainingMilliseconds() <= 0) {
      acquisitionPartial = true;
      break;
    }
    if (result.status !== 'found' || result.truncated || result.text === undefined || !result.blobSha) {
      acquisitionPartial = true;
      continue;
    }
    const bytes = Buffer.byteLength(result.text, 'utf8');
    const lines = normalizedLines(result.text);
    if (
      result.text.includes('\0') ||
      lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_SOURCE_LINE_BYTES) ||
      totalBytes + bytes > input.configuration.limits.maximumTotalBytes
    ) {
      acquisitionPartial = true;
      continue;
    }
    totalBytes += bytes;
    files.push({
      path,
      opaqueId: `f${String(files.length + 1).padStart(4, '0')}`,
      text: result.text,
      lines,
      bytes,
      blobSha: result.blobSha,
      file,
    });
  }
  if (files.length < selected.length) acquisitionPartial = true;
  await input.assertFresh?.();

  const acquisitionSkippedPaths = new Set(
    requiredPaths.map(([path]) => path).filter((path) => !files.some((file) => file.path === path)),
  );
  const analysisSkippedPaths = new Set(acquisitionSkippedPaths);
  const inputDigest = digest('code-review/analyzer-input/v1', {
    repository: `${input.pullRequest.owner}/${input.pullRequest.repository}`,
    pullRequest: input.pullRequest.number,
    baseSha: input.pullRequest.baseSha,
    headSha: input.pullRequest.headSha,
    diffDigest: digest('code-review/analyzer-diff/v1', input.diff.text),
    manifestDigest: input.configuration.manifestDigest,
    limits: input.configuration.limits,
    files: files.map((file) => ({
      opaqueId: file.opaqueId,
      path: file.path,
      blobSha: file.blobSha,
      contentDigest: digest('code-review/analyzer-file/v1', file.text),
    })),
    omittedPaths: [...acquisitionSkippedPaths],
  });

  let remainingObservations = input.configuration.limits.maximumObservations;
  const runs: AnalyzerRunV1[] = [];
  for (const enabled of input.configuration.analyzers) {
    const eligible = files.filter((file) => analyzerSupports(enabled.id, file.path));
    const expectedEligible = selected.filter(([path]) => analyzerSupports(enabled.id, path)).length;
    let runPartial = expectedEligible !== eligible.length || acquisitionPartial;
    let outOfScopeObservations = 0;
    let analyzedFiles = 0;
    const observations: AnalyzerObservationV1[] = [];
    const observationDigests = new Set<string>();
    fileLoop: for (const file of eligible) {
      if (remainingMilliseconds() <= 0) {
        runPartial = true;
        analysisSkippedPaths.add(file.path);
        break;
      }
      let batch: DiagnosticBatch;
      try {
        batch = rawDiagnostics(enabled.id, file, enabled.rules, remainingObservations + 1);
      } catch {
        runPartial = true;
        analysisSkippedPaths.add(file.path);
        continue;
      }
      if (remainingMilliseconds() <= 0) {
        runPartial = true;
        analysisSkippedPaths.add(file.path);
        break;
      }
      if (batch.resourceLimited) {
        runPartial = true;
        analysisSkippedPaths.add(file.path);
        continue;
      }
      analyzedFiles += 1;
      if (batch.generationTruncated) runPartial = true;
      for (const raw of batch.diagnostics) {
        const addition = changedAddition(file.file, raw.line);
        const evidence = file.lines[raw.line - 1];
        if (!addition || evidence === undefined || evidence !== addition.text) {
          if (outOfScopeObservations >= MAX_ANALYZER_OUT_OF_SCOPE_OBSERVATIONS) {
            runPartial = true;
            break fileLoop;
          }
          outOfScopeObservations += 1;
          continue;
        }
        const message = sanitizeMessage(raw.message);
        if (!isAnalyzerEvidence(evidence) || !isAnalyzerMessage(message)) {
          runPartial = true;
          analysisSkippedPaths.add(file.path);
          continue;
        }
        if (containsSecret(`${file.path}\n${evidence}\n${message}`, input.secrets ?? [])) {
          throw new Error('Deterministic analyzer result contains forbidden secret data');
        }
        if (remainingObservations <= 0) {
          runPartial = true;
          break fileLoop;
        }
        const withoutDigest = {
          ruleId: raw.ruleId,
          path: file.path,
          side: 'RIGHT' as const,
          line: raw.line,
          column: raw.column,
          evidence,
          message,
        };
        const candidateDigest = observationDigest(enabled.id, ANALYZER_VERSIONS[enabled.id], withoutDigest);
        if (observationDigests.has(candidateDigest)) continue;
        observationDigests.add(candidateDigest);
        observations.push({ ...withoutDigest, digest: candidateDigest });
        remainingObservations -= 1;
      }
      if (remainingMilliseconds() <= 0) {
        runPartial = true;
        break;
      }
    }
    runs.push({
      analyzer: enabled.id,
      analyzerVersion: ANALYZER_VERSIONS[enabled.id],
      status: runPartial ? 'partial' : 'complete',
      enabledRules: [...enabled.rules],
      eligibleFiles: expectedEligible,
      analyzedFiles,
      skippedFiles: Math.max(0, expectedEligible - analyzedFiles),
      outOfScopeObservations,
      observations,
    });
  }
  const report = createBoundedAnalyzerReport(inputDigest, runs, acquisitionPartial);
  await input.assertFresh?.();
  const findings = report.runs.flatMap((run) =>
    run.observations.map((observation) => ruleFinding(run.analyzer, run.analyzerVersion, observation)),
  );
  const analyzerContext = contextItems(report, input.configuration, input.pullRequest.headSha);
  const summary: AnalyzerSummary = {
    mode: input.configuration.mode,
    configStatus: input.configuration.status,
    manifestDigest: input.configuration.manifestDigest,
    inputDigest: report.inputDigest,
    resultDigest: report.resultDigest,
    coverage: report.coverage,
    runCount: report.runs.length,
    acceptedObservations: findings.length,
    skippedFiles: analysisSkippedPaths.size,
    outOfScopeObservations: report.runs.reduce((total, run) => total + run.outOfScopeObservations, 0),
    contextTruncated: analyzerContext.truncated,
    unavailableSourceCount: analysisSkippedPaths.size,
    runs: report.runs.map((run) => ({
      analyzer: run.analyzer,
      analyzerVersion: run.analyzerVersion,
      status: run.status,
      analyzedFiles: run.analyzedFiles,
      skippedFiles: run.skippedFiles,
      acceptedObservations: run.observations.length,
    })),
  };
  return { report, findings, contextItems: analyzerContext.items, summary };
}

export function emptyDeterministicAnalysis(configuration: AnalyzerConfiguration): DeterministicAnalysis {
  const inputDigest = digest('code-review/analyzer-input/v1', {
    manifestDigest: configuration.manifestDigest,
    disabled: true,
  });
  const report = createAnalyzerReport({ inputDigest, coverage: 'complete', runs: [] });
  return {
    report,
    findings: [],
    contextItems: [],
    summary: {
      mode: configuration.mode,
      configStatus: configuration.status,
      manifestDigest: configuration.manifestDigest,
      inputDigest,
      resultDigest: report.resultDigest,
      coverage: 'complete',
      runCount: 0,
      acceptedObservations: 0,
      skippedFiles: 0,
      outOfScopeObservations: 0,
      contextTruncated: false,
      unavailableSourceCount: 0,
      runs: [],
    },
  };
}
