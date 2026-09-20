import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CGC_VERSION, DEFAULT_GITNEXUS_VERSION, type CodeIndexer } from './config';
import {
  MAX_QUERY_INCLUDED_BYTES,
  MAX_QUERY_OUTPUT_BYTES,
  MAX_QUERY_PHASE_OUTPUT_BYTES,
  MAX_QUERY_PHASE_TIMEOUT_MS,
  MAX_QUERY_TIMEOUT_MS,
  truncateUtf8,
  type ContextQueryPlan,
  type ContextSourceStatus,
} from './context-planner';
import type { GitHubClient, PullRequestContext, PullRequestDiff } from './github';
import { extractRepositoryArchive } from './repository-archive';

const MAX_ARCHIVE_DOWNLOAD_BYTES = 250 * 1024 * 1024;
export const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 5_000_000;
const INDEX_COMMAND_TIMEOUT_MS = 20 * 60_000;
const INSTALL_COMMAND_TIMEOUT_MS = 10 * 60_000;
const CACHE_SCHEMA = 'index-v1';
const MAX_CACHE_FILES = 100_000;
const MAX_CACHE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

export interface CommandOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  killGraceMs?: number;
  maximumOutputBytes?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface CacheAdapter {
  isAvailable(): boolean;
  restore(paths: string[], primaryKey: string, restoreKeys: string[]): Promise<string | undefined>;
  save(paths: string[], key: string): Promise<number>;
}

export interface CodeIndexRequest {
  indexer: Exclude<CodeIndexer, 'none'>;
  cacheKey: string;
  cacheTtlMs: number;
  github: GitHubClient;
  pullRequest: PullRequestContext;
  queries?: readonly ContextQueryPlan[];
  /** Compatibility only for existing adapter fixtures; production supplies an explicit lexical query plan. */
  diff?: PullRequestDiff;
  environment?: NodeJS.ProcessEnv;
  cache?: CacheAdapter;
  commandRunner?: CommandRunner;
  archiveExtractor?: typeof extractRepositoryArchive;
  now?: () => number;
  clock?: () => number;
  temporaryRoot?: string;
}

export interface IndexQueryResult {
  query: ContextQueryPlan;
  status: ContextSourceStatus;
  content?: string;
  acquiredBytes: number;
  reason?:
    | 'query-failed'
    | 'query-timeout'
    | 'query-output-limit'
    | 'malformed-output'
    | 'aggregate-time-limit'
    | 'aggregate-output-limit';
}

export interface CodeIndexResult {
  indexer: Exclude<CodeIndexer, 'none'>;
  version: string;
  results: IndexQueryResult[];
  /** Compatibility rendering for adapter integration fixtures; production uses provenance-bearing results. */
  context: string;
  cacheHit: boolean;
}

interface CacheMetadata {
  createdAt: string;
  indexer: Exclude<CodeIndexer, 'none'>;
  version: string;
  repository: string;
  baseSha: string;
  platform: NodeJS.Platform;
  architecture: string;
  schema: string;
}

const defaultCache: CacheAdapter = {
  isAvailable: () => Boolean(process.env.ACTIONS_CACHE_URL || process.env.ACTIONS_RESULTS_URL),
  restore: async (paths, primaryKey, restoreKeys) => {
    const actionsCache = await import('@actions/cache');
    return actionsCache.restoreCache(paths, primaryKey, restoreKeys);
  },
  save: async (paths, key) => {
    const actionsCache = await import('@actions/cache');
    return actionsCache.saveCache(paths, key);
  },
};

function cleanEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'USER',
    'LOGNAME',
    'SHELL',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'LD_LIBRARY_PATH',
    'NIX_LD_LIBRARY_PATH',
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (source[name]) {
      environment[name] = source[name];
    }
  }
  environment.HOME = home;
  if (!environment.LD_LIBRARY_PATH && environment.NIX_LD_LIBRARY_PATH) {
    environment.LD_LIBRARY_PATH = environment.NIX_LD_LIBRARY_PATH;
  }
  environment.CI = 'true';
  environment.NO_COLOR = '1';
  return environment;
}

function processGroupExists(child: ReturnType<typeof spawn>): boolean {
  if (!child.pid || process.platform === 'win32') {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    child.kill(signal);
  }
}

export const runCommand: CommandRunner = async (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.environment,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      stop(new Error(`${command} timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    timeoutTimer.unref();

    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };
    const rejectAfterKill = (): void => {
      if (settled || !failure) {
        return;
      }
      terminateProcessGroup(child, 'SIGKILL');
      settled = true;
      clearTimers();
      reject(failure);
    };
    const stop = (error: Error): void => {
      if (failure || settled) {
        return;
      }
      failure = error;
      terminateProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(rejectAfterKill, options.killGraceMs ?? 5_000);
    };
    const append = (current: string, chunk: Buffer): string => {
      if (failure) return current;
      capturedBytes += chunk.byteLength;
      const maximumOutputBytes = options.maximumOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
      if (capturedBytes > maximumOutputBytes) {
        stop(new Error(`${command} output exceeded ${maximumOutputBytes} bytes`));
        return current;
      }
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      if (settled || (failure && processGroupExists(child))) {
        return;
      }
      settled = true;
      clearTimers();
      reject(failure ?? error);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      clearTimeout(timeoutTimer);
      if (failure && processGroupExists(child)) {
        return;
      }
      if (!failure && code !== 0) {
        const error = new Error(
          `${command} exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}; output suppressed`,
        );
        if (processGroupExists(child)) {
          stop(error);
          return;
        }
        failure = error;
      }
      settled = true;
      clearTimers();
      if (failure) {
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function versionFor(indexer: Exclude<CodeIndexer, 'none'>): string {
  return indexer === 'cgc' ? DEFAULT_CGC_VERSION : DEFAULT_GITNEXUS_VERSION;
}

export function buildIndexSearchQuery(pullRequest: PullRequestContext, diff: PullRequestDiff): string {
  const path = diff.parsed?.files.find((file) => file.apiPath)?.apiPath ?? /\+\+\+ b\/([^\r\n]+)/u.exec(diff.text)?.[1];
  return [pullRequest.title, path].filter(Boolean).join(' ').slice(0, 1_000);
}

export function limitIndexContext(value: string): string {
  const sanitized = stripUnsafeOutput(value, '');
  if (Buffer.byteLength(sanitized, 'utf8') <= 50_000) return sanitized;
  return `${truncateUtf8(sanitized, 49_970).value}\n[index context truncated]`;
}

function compatibilityQueries(request: CodeIndexRequest): readonly ContextQueryPlan[] {
  if (request.queries) return request.queries;
  const path = request.diff?.parsed?.files.find((file) => file.apiPath)?.apiPath ?? 'src/index.ts';
  return [
    {
      id: 'q01',
      kind: 'configuration',
      anchor: {
        value: 'runReview',
        kind: 'lexical',
        language: 'compatibility',
        path,
        provenance: [{ path, side: 'RIGHT', line: 1, lineKind: 'addition' }],
      },
    },
  ];
}

function safeRepositoryId(pullRequest: PullRequestContext): string {
  return createHash('sha256').update(`${pullRequest.owner}/${pullRequest.repository}`).digest('hex').slice(0, 16);
}

function cacheKeys(request: CodeIndexRequest, now: number): { primary: string; restore: string[] } {
  const version = versionFor(request.indexer);
  const prefix = `${request.cacheKey}-${CACHE_SCHEMA}-${request.indexer}-${version}-${process.platform}-${process.arch}-${safeRepositoryId(request.pullRequest)}-`;
  const bucket = Math.floor(now / request.cacheTtlMs);
  const generation =
    process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
      ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
      : randomUUID();
  const revisionPrefix = `${prefix}${request.pullRequest.baseSha}-`;
  return {
    primary: `${revisionPrefix}${bucket}-${generation}`,
    restore: [`${revisionPrefix}${bucket}-`, revisionPrefix],
  };
}

async function cacheIsFresh(
  databasePath: string,
  metadataPath: string,
  request: CodeIndexRequest,
  now: number,
): Promise<CacheMetadata | undefined> {
  try {
    if (!(await validateRegularTree(databasePath))) return undefined;
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<CacheMetadata>;
    const createdAt = Date.parse(metadata.createdAt ?? '');
    const valid =
      metadata.indexer === request.indexer &&
      metadata.version === versionFor(request.indexer) &&
      metadata.repository === `${request.pullRequest.owner}/${request.pullRequest.repository}` &&
      metadata.baseSha === request.pullRequest.baseSha &&
      metadata.platform === process.platform &&
      metadata.architecture === process.arch &&
      metadata.schema === CACHE_SCHEMA &&
      (await databaseHasContent(request.indexer, databasePath)) &&
      Number.isFinite(createdAt) &&
      now - createdAt >= 0 &&
      now - createdAt <= request.cacheTtlMs;
    return valid ? (metadata as CacheMetadata) : undefined;
  } catch {
    return undefined;
  }
}

async function validateRegularTree(path: string): Promise<boolean> {
  try {
    const pending = [path];
    let files = 0;
    let bytes = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      const details = await lstat(current);
      if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) return false;
      if (details.isFile()) {
        files += 1;
        bytes += details.size;
        if (files > MAX_CACHE_FILES || details.size > MAX_CACHE_FILE_BYTES || bytes > MAX_CACHE_BYTES) {
          return false;
        }
        continue;
      }
      for (const entry of await readdir(current)) pending.push(join(current, entry));
    }
    return true;
  } catch {
    return false;
  }
}

async function containsRegularFile(path: string): Promise<boolean> {
  try {
    const pending = [path];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        break;
      }
      const details = await lstat(current);
      if (details.isFile() && details.size > 0) {
        return true;
      }
      if (!details.isDirectory()) {
        continue;
      }
      for (const entry of await readdir(current)) {
        pending.push(join(current, entry));
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function removeRepositoryIndexerControls(sourcePath: string): Promise<void> {
  const pending = [sourcePath];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (
        entry.name === '.gitnexusrc' ||
        entry.name === 'mcp.json' ||
        entry.name === '.codegraphcontext' ||
        entry.name === '.env' ||
        entry.name.startsWith('.env.')
      ) {
        await rm(path, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
}

async function databaseHasContent(indexer: Exclude<CodeIndexer, 'none'>, databasePath: string): Promise<boolean> {
  if (indexer === 'cgc') {
    return containsRegularFile(join(databasePath, 'graph'));
  }
  const required = [
    join(databasePath, 'graph', 'gitnexus.json'),
    join(databasePath, 'graph', 'lbug'),
    join(databasePath, 'home', '.gitnexus', 'registry.json'),
  ];
  return (await Promise.all(required.map((path) => containsRegularFile(path)))).every(Boolean);
}

function stripUnsafeOutput(value: string, sourcePath: string): string {
  const withoutPaths = sourcePath
    ? value.replaceAll(sourcePath, '<base>').replaceAll(sourcePath.replaceAll('\\', '/'), '<base>')
    : value;
  return (
    withoutPaths
      // eslint-disable-next-line no-control-regex -- ANSI and other control bytes are never useful model context.
      .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
      // eslint-disable-next-line no-control-regex -- Preserve only tab and line endings from external text.
      .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
      .trim()
  );
}

function strictGitNexusJson(output: string): string {
  let value: unknown;
  try {
    value = JSON.parse(output.trim()) as unknown;
  } catch {
    throw new Error('malformed-output');
  }
  if ((typeof value !== 'object' || value === null) && !Array.isArray(value)) throw new Error('malformed-output');
  if (!Array.isArray(value) && (value as Record<string, unknown>).partial === true) throw new Error('malformed-output');
  return JSON.stringify(value);
}

function queryArgumentSets(
  indexer: Exclude<CodeIndexer, 'none'>,
  databasePath: string,
  query: ContextQueryPlan,
): string[][] {
  const anchor = query.anchor.value;
  const path = query.anchor.path;
  if (
    !/^[\p{ID_Start}_$][\p{ID_Continue}$:!?=]*$/u.test(anchor) ||
    /\p{Cc}|\p{Cf}/u.test(anchor) ||
    Buffer.byteLength(anchor, 'utf8') > 128
  ) {
    throw new Error('Context query anchor is unsafe');
  }
  const pathSegments = path.split('/');
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /\p{Cc}|\p{Cf}/u.test(path) ||
    Buffer.byteLength(path, 'utf8') > 1_024 ||
    pathSegments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('-'))
  ) {
    throw new Error('Context query path is unsafe');
  }
  if (indexer === 'cgc') {
    const prefix = ['--database', 'kuzudb', '--path', databasePath];
    if (query.kind === 'definition-and-types') {
      const commands = [[...prefix, 'find', 'name', anchor, '--no-fuzzy']];
      if (query.anchor.kind === 'type') {
        commands.push([...prefix, 'analyze', 'tree', anchor, '--file', path]);
      }
      return commands;
    }
    if (query.kind === 'callers-and-tests') {
      return [[...prefix, 'analyze', 'callers', anchor, '--file', path]];
    }
    if (query.kind === 'callees') return [[...prefix, 'analyze', 'calls', anchor, '--file', path]];
    return [[...prefix, 'find', 'content', anchor]];
  }
  if (query.kind === 'definition-and-types') {
    return [['context', anchor, '--repo', 'code-review-base', '--file', path, '--limit', '20', '--content']];
  }
  if (query.kind === 'callers-and-tests') {
    return [
      [
        'impact',
        anchor,
        '--repo',
        'code-review-base',
        '--file',
        path,
        '--direction',
        'upstream',
        '--depth',
        '2',
        '--include-tests',
        '--limit',
        '20',
      ],
    ];
  }
  if (query.kind === 'callees') {
    return [
      [
        'impact',
        anchor,
        '--repo',
        'code-review-base',
        '--file',
        path,
        '--direction',
        'downstream',
        '--depth',
        '1',
        '--limit',
        '20',
      ],
    ];
  }
  return [['query', `${anchor} configuration`, '--repo', 'code-review-base', '--limit', '3', '--content']];
}

async function installCgc(toolsPath: string, options: CommandOptions, runner: CommandRunner): Promise<string> {
  const venv = join(toolsPath, 'cgc');
  await runner('python3', ['-m', 'venv', venv], options);
  const python = join(venv, 'bin', 'python');
  await runner(
    python,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `codegraphcontext==${DEFAULT_CGC_VERSION}`],
    options,
  );
  return join(venv, 'bin', 'cgc');
}

async function installGitNexus(toolsPath: string, options: CommandOptions, runner: CommandRunner): Promise<string> {
  const prefix = join(toolsPath, 'gitnexus');
  const environment = {
    ...options.environment,
    GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1',
  };
  await runner(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `gitnexus@${DEFAULT_GITNEXUS_VERSION}`,
    ],
    { ...options, environment },
  );
  return join(prefix, 'node_modules', '.bin', 'gitnexus');
}

async function indexWithCgc(
  executable: string,
  sourcePath: string,
  databasePath: string,
  cacheHit: boolean,
  options: CommandOptions,
  runner: CommandRunner,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...options.environment, CGC_EMBEDDED_BUFFER_POOL_MB: '512' };
  const indexArgs = ['--database', 'kuzudb', '--path', databasePath, 'index', sourcePath, '--no-progress'];
  if (!cacheHit) indexArgs.push('--force');
  await runner(executable, indexArgs, { ...options, environment });
  return environment;
}

async function rewriteGitNexusRegistry(databasePath: string, sourcePath: string): Promise<void> {
  const registryPath = join(databasePath, '..', 'home', '.gitnexus', 'registry.json');
  const value = JSON.parse(await readFile(registryPath, 'utf8')) as unknown;
  if (!Array.isArray(value)) {
    throw new Error('GitNexus cache registry must be an array');
  }
  let found = false;
  const entries = value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || (entry as Record<string, unknown>).name !== 'code-review-base') {
      return entry;
    }
    found = true;
    return {
      ...(entry as Record<string, unknown>),
      path: sourcePath,
      storagePath: databasePath,
    };
  });
  if (!found) {
    throw new Error('GitNexus cache registry has no code-review-base entry');
  }
  await writeFile(registryPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

  for (const name of ['gitnexus.json', 'meta.json']) {
    const metadataPath = join(databasePath, name);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new Error(`GitNexus ${name} must contain an object`);
    }
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          ...(metadata as Record<string, unknown>),
          repoPath: sourcePath,
          storagePath: databasePath,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
}

async function indexWithGitNexus(
  executable: string,
  sourcePath: string,
  databasePath: string,
  cacheHit: boolean,
  options: CommandOptions,
  runner: CommandRunner,
): Promise<NodeJS.ProcessEnv> {
  const gitNexusHome = join(databasePath, '..', 'home');
  await mkdir(gitNexusHome, { recursive: true });
  const environment = {
    ...options.environment,
    HOME: gitNexusHome,
    GITNEXUS_STORAGE_PATH: databasePath,
    GITNEXUS_CONTENT_RETENTION: 'symbol',
    GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1',
  };
  if (cacheHit) await rewriteGitNexusRegistry(databasePath, sourcePath);
  else {
    await runner(executable, ['analyze', sourcePath, '--index-only', '--skip-git', '--name', 'code-review-base'], {
      ...options,
      environment,
    });
  }
  return environment;
}

async function executeQueries(input: {
  indexer: Exclude<CodeIndexer, 'none'>;
  executable: string;
  databasePath: string;
  sourcePath: string;
  queries: readonly ContextQueryPlan[];
  options: CommandOptions;
  environment: NodeJS.ProcessEnv;
  runner: CommandRunner;
  clock: () => number;
}): Promise<IndexQueryResult[]> {
  const startedAt = input.clock();
  let acquiredBytes = 0;
  const results: IndexQueryResult[] = [];
  for (const query of input.queries) {
    const elapsed = input.clock() - startedAt;
    if (elapsed >= MAX_QUERY_PHASE_TIMEOUT_MS) {
      results.push({ query, status: 'budget-exhausted', acquiredBytes: 0, reason: 'aggregate-time-limit' });
      continue;
    }
    if (acquiredBytes >= MAX_QUERY_PHASE_OUTPUT_BYTES) {
      results.push({ query, status: 'budget-exhausted', acquiredBytes: 0, reason: 'aggregate-output-limit' });
      continue;
    }
    let queryBytes = 0;
    try {
      const stdout: string[] = [];
      let commandElapsed = elapsed;
      for (const args of queryArgumentSets(input.indexer, input.databasePath, query)) {
        const remainingPhaseMs = MAX_QUERY_PHASE_TIMEOUT_MS - commandElapsed;
        const remainingQueryMs = MAX_QUERY_TIMEOUT_MS - (commandElapsed - elapsed);
        if (remainingPhaseMs <= 1 || remainingQueryMs <= 1) throw new Error('context query timed out');
        const remainingMs = Math.min(remainingPhaseMs, remainingQueryMs);
        const killGraceMs = Math.min(1_000, Math.max(1, Math.floor(remainingMs / 2)));
        const result = await input.runner(input.executable, args, {
          ...input.options,
          environment: input.environment,
          timeoutMs: Math.max(1, remainingMs - killGraceMs),
          killGraceMs,
          maximumOutputBytes: Math.min(
            MAX_QUERY_OUTPUT_BYTES - queryBytes,
            MAX_QUERY_PHASE_OUTPUT_BYTES - acquiredBytes,
          ),
        });
        const commandBytes = Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8');
        queryBytes += commandBytes;
        acquiredBytes += commandBytes;
        stdout.push(result.stdout);
        commandElapsed = input.clock() - startedAt;
      }
      let content = stripUnsafeOutput(
        input.indexer === 'gitnexus' ? strictGitNexusJson(stdout.join('')) : stdout.join('\n'),
        input.sourcePath,
      );
      const originalContentBytes = Buffer.byteLength(content, 'utf8');
      if (originalContentBytes === 0) {
        results.push({ query, status: 'empty', acquiredBytes: queryBytes });
        continue;
      }
      let status: ContextSourceStatus = 'included';
      if (originalContentBytes > MAX_QUERY_INCLUDED_BYTES) {
        content = truncateUtf8(content, MAX_QUERY_INCLUDED_BYTES).value;
        status = 'truncated';
      }
      results.push({ query, status, content, acquiredBytes: queryBytes });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const timedOut = /timed out/u.test(message);
      const outputLimit = /output exceeded/u.test(message);
      const chargedBytes = outputLimit
        ? Math.min(MAX_QUERY_OUTPUT_BYTES - queryBytes, MAX_QUERY_PHASE_OUTPUT_BYTES - acquiredBytes)
        : 0;
      acquiredBytes += chargedBytes;
      results.push({
        query,
        status: timedOut ? 'timed-out' : 'unavailable',
        acquiredBytes: queryBytes + chargedBytes,
        reason: timedOut
          ? 'query-timeout'
          : outputLimit
            ? 'query-output-limit'
            : /malformed-output/u.test(message)
              ? 'malformed-output'
              : 'query-failed',
      });
    }
  }
  return results;
}

export async function runCodeIndexer(request: CodeIndexRequest): Promise<CodeIndexResult> {
  const now = request.now?.() ?? Date.now();
  const root = request.temporaryRoot ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(root, { recursive: true });
  const workspace = join(root, 'code-review-index', safeRepositoryId(request.pullRequest), request.indexer);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const sourcePath = join(workspace, 'source');
  const toolsPath = join(workspace, 'tools');
  const databasePath = join(workspace, 'database');
  const metadataPath = join(databasePath, 'code-review-cache.json');
  const archivePath = join(workspace, 'base.tar.gz');
  const homePath = join(workspace, 'home');
  const runner = request.commandRunner ?? runCommand;
  const cache = request.cache ?? defaultCache;
  const environment = cleanEnvironment(request.environment ?? process.env, homePath);
  const installOptions: CommandOptions = {
    cwd: workspace,
    environment,
    timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
  };
  const indexOptions: CommandOptions = {
    cwd: sourcePath,
    environment,
    timeoutMs: INDEX_COMMAND_TIMEOUT_MS,
  };
  const keys = cacheKeys(request, now);
  let restoredKey: string | undefined;
  let restoredMetadata: CacheMetadata | undefined;
  let cacheHit = false;

  try {
    await Promise.all([
      mkdir(sourcePath, { recursive: true }),
      mkdir(toolsPath, { recursive: true }),
      mkdir(homePath, { recursive: true }),
    ]);

    if (cache.isAvailable()) {
      try {
        restoredKey = await cache.restore([databasePath], keys.primary, keys.restore);
        restoredMetadata =
          restoredKey === undefined ? undefined : await cacheIsFresh(databasePath, metadataPath, request, now);
        cacheHit = restoredMetadata !== undefined;
        if (restoredKey && !cacheHit) {
          console.log('Ignoring stale code index cache');
          await rm(databasePath, { recursive: true, force: true });
        }
      } catch {
        await rm(databasePath, { recursive: true, force: true });
        console.warn('Unable to restore code index cache; rebuilding without restored state');
      }
    } else {
      console.log('GitHub Actions cache service is unavailable; indexing without cache');
    }

    await mkdir(databasePath, { recursive: true });
    const archiveBytes = await request.github.downloadRepositoryArchive(
      request.pullRequest,
      request.pullRequest.baseSha,
      archivePath,
      MAX_ARCHIVE_DOWNLOAD_BYTES,
      AbortSignal.timeout(ARCHIVE_DOWNLOAD_TIMEOUT_MS),
    );
    console.log(`Downloaded ${archiveBytes} base-revision archive bytes`);
    await (request.archiveExtractor ?? extractRepositoryArchive)(archivePath, sourcePath);
    await removeRepositoryIndexerControls(sourcePath);

    const executable =
      request.indexer === 'cgc'
        ? await installCgc(toolsPath, installOptions, runner)
        : await installGitNexus(toolsPath, installOptions, runner);
    const graphPath = join(databasePath, 'graph');
    const performIndex = async (): Promise<NodeJS.ProcessEnv> =>
      request.indexer === 'cgc'
        ? indexWithCgc(executable, sourcePath, graphPath, cacheHit, indexOptions, runner)
        : indexWithGitNexus(executable, sourcePath, graphPath, cacheHit, indexOptions, runner);
    let queryEnvironment: NodeJS.ProcessEnv;
    try {
      queryEnvironment = await performIndex();
    } catch (error) {
      if (!cacheHit) throw error;
      console.warn('Restored code index failed; rebuilding from an empty database');
      cacheHit = false;
      restoredMetadata = undefined;
      await rm(databasePath, { recursive: true, force: true });
      await mkdir(databasePath, { recursive: true });
      queryEnvironment = await performIndex();
    }

    const metadata: CacheMetadata = {
      createdAt: restoredMetadata?.createdAt ?? new Date(now).toISOString(),
      indexer: request.indexer,
      version: versionFor(request.indexer),
      repository: `${request.pullRequest.owner}/${request.pullRequest.repository}`,
      baseSha: request.pullRequest.baseSha,
      platform: process.platform,
      architecture: process.arch,
      schema: CACHE_SCHEMA,
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');

    if (cache.isAvailable() && !cacheHit) {
      const saveKey = restoredKey === keys.primary ? `${keys.primary}-repair-${randomUUID()}` : keys.primary;
      try {
        await cache.save([databasePath], saveKey);
      } catch {
        console.warn('Unable to save code index cache; continuing without a saved index');
      }
    }

    const results = await executeQueries({
      indexer: request.indexer,
      executable,
      databasePath: graphPath,
      sourcePath,
      queries: compatibilityQueries(request),
      options: indexOptions,
      environment: queryEnvironment,
      runner,
      clock: request.clock ?? Date.now,
    });
    const context = limitIndexContext(
      `Indexer: ${request.indexer} ${versionFor(request.indexer)}\nBase revision: ${request.pullRequest.baseSha}\n\n${results
        .filter((result) => result.content)
        .map((result) => `${result.query.kind}:${result.query.anchor.value}\n${result.content}`)
        .join('\n\n')}`,
    );
    return { indexer: request.indexer, version: versionFor(request.indexer), results, context, cacheHit };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
