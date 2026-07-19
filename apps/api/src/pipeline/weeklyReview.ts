import { parseGeneratedAt } from '../db/time.js';
import type { LoadedWeeklyReview, WeeklyReviewMetrics } from '../db/weeklyReview.js';
import type { DeepSeekClient } from '../providers/deepseek.js';
import { ProviderError } from '../providers/errors.js';

/**
 * Decision + narration for the weekly forward-outcome review. Mirrors pipeline/briefing.ts's split
 * with runPipeline.ts's attachBriefing: this module stays pure (no db, no config, no env var
 * reads) -- refresh/runtime.ts's attachWeeklyReview is the impure orchestration that calls these,
 * reads config/db, and never lets a failure here fail the refresh.
 */

const REVIEW_INTERVAL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * True when a weekly review computation should run now: there is nothing to summarize without at
 * least one labeled row in the trailing window, and there is nothing new to say while the latest
 * review is still within the 7-day interval (an empty table -- `latest === null` -- always passes).
 */
export function shouldGenerateWeeklyReview(
  latest: LoadedWeeklyReview | null,
  hasLabeledRowsInWindow: boolean,
  now: Date,
): boolean {
  if (!hasLabeledRowsInWindow) {
    return false;
  }
  if (latest === null) {
    return true;
  }
  const latestInstant = parseGeneratedAt(latest.generated_at);
  return now.getTime() - latestInstant.getTime() >= REVIEW_INTERVAL_DAYS * MS_PER_DAY;
}

export const WEEKLY_REVIEW_SYSTEM_PROMPT =
  'You write a weekly forward-outcome review for a crypto screener. Using ONLY the JSON figures ' +
  'given, write plain prose of at most 8 sentences -- no markdown, no headers, no bullet points, ' +
  'no advice, no recommendations, no trade calls. Restate only the figures you are given, in your ' +
  "own words -- never invent a number, a rate, or a trend the JSON doesn't contain. Always state " +
  'the n behind every figure you mention. Make no claims of statistical significance. When any ' +
  'cohort has n below 30, say explicitly that the sample is too thin to conclude anything from it.';

export interface WeeklyReviewNarration {
  text: string;
  model: string;
}

export async function generateWeeklyReviewNarrative(
  client: DeepSeekClient,
  metrics: WeeklyReviewMetrics,
): Promise<WeeklyReviewNarration> {
  const completion = await client.complete(WEEKLY_REVIEW_SYSTEM_PROMPT, JSON.stringify(metrics));
  const text = completion.text.trim();
  if (text.length === 0) {
    throw new ProviderError('DeepSeek weekly review completion was empty after trimming');
  }
  return { text, model: completion.model };
}
