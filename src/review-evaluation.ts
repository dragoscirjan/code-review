import { ReviewContractError, parseReviewResult, type ReviewResultV1 } from './review-contract';

export interface RecordedReviewFixture {
  name: string;
  assistantOutput: string;
}

export interface RecordedReviewFixtureResult {
  name: string;
  review?: ReviewResultV1;
  malformed: boolean;
}

export interface RecordedReviewEvaluation {
  total: number;
  valid: number;
  malformed: number;
  malformedOutputRate: number;
  results: RecordedReviewFixtureResult[];
}

/** Replays recorded assistant payloads through the production contract parser without a model or network. */
export function evaluateRecordedReviewOutputs(fixtures: readonly RecordedReviewFixture[]): RecordedReviewEvaluation {
  const results = fixtures.map((fixture): RecordedReviewFixtureResult => {
    try {
      return { name: fixture.name, review: parseReviewResult(fixture.assistantOutput), malformed: false };
    } catch (error) {
      if (!(error instanceof ReviewContractError)) throw error;
      return { name: fixture.name, malformed: true };
    }
  });
  const malformed = results.filter((result) => result.malformed).length;
  return {
    total: results.length,
    valid: results.length - malformed,
    malformed,
    malformedOutputRate: results.length === 0 ? 0 : malformed / results.length,
    results,
  };
}
