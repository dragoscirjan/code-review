import { parseStrictJson } from './strict-json';

export const SPECIALIST_ARBITER_CONTRACT_VERSION = 1 as const;
export const MAX_ARBITER_OUTPUT_BYTES = 2_048;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;

export interface ArbiterDecisionV1 {
  version: typeof SPECIALIST_ARBITER_CONTRACT_VERSION;
  rejectedCandidateIds: string[];
}

export class SpecialistContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecialistContractError';
  }
}

function fail(message: string): never {
  throw new SpecialistContractError(message);
}

export function parseArbiterDecision(raw: string, candidateIds: readonly string[]): ArbiterDecisionV1 {
  let value: unknown;
  try {
    value = parseStrictJson(raw, MAX_ARBITER_OUTPUT_BYTES, 4);
  } catch {
    return fail('Arbiter output must be one bounded strict JSON document');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Arbiter output must be an object');
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 2 || !Object.hasOwn(object, 'version') || !Object.hasOwn(object, 'rejectedCandidateIds')) {
    return fail('Arbiter output contains unknown or missing fields');
  }
  if (object.version !== SPECIALIST_ARBITER_CONTRACT_VERSION) return fail('Unsupported arbiter contract version');
  if (!Array.isArray(object.rejectedCandidateIds) || object.rejectedCandidateIds.length > 10) {
    return fail('Arbiter rejectedCandidateIds must be an array of at most ten IDs');
  }
  if (object.rejectedCandidateIds.some((id) => typeof id !== 'string' || !DIGEST_PATTERN.test(id))) {
    return fail('Arbiter candidate ID is malformed');
  }
  const rejectedCandidateIds = object.rejectedCandidateIds as string[];
  if (new Set(rejectedCandidateIds).size !== rejectedCandidateIds.length) {
    return fail('Arbiter candidate IDs must be unique');
  }
  const allowed = new Set(candidateIds);
  if (allowed.size !== candidateIds.length || rejectedCandidateIds.some((id) => !allowed.has(id))) {
    return fail('Arbiter output contains an unknown or ambiguous candidate ID');
  }
  return { version: 1, rejectedCandidateIds };
}
