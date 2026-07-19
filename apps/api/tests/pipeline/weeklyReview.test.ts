import { describe, expect, it, vi } from 'vitest';
import { formatJakartaIso } from '../../src/db/time.js';
import type { LoadedWeeklyReview, WeeklyReviewMetrics } from '../../src/db/weeklyReview.js';
import { computeWeeklyReviewMetrics } from '../../src/db/weeklyReview.js';
import {
  generateWeeklyReviewNarrative,
  shouldGenerateWeeklyReview,
} from '../../src/pipeline/weeklyReview.js';
import type { DeepSeekClient, DeepSeekCompletion } from '../../src/providers/deepseek.js';

const NOW = new Date('2026-07-19T00:00:00.000Z');

function loadedReview(generatedAt: string): LoadedWeeklyReview {
  return {
    generated_at: generatedAt,
    week_start: generatedAt,
    week_end: generatedAt,
    metrics: {},
    narrative: null,
    model: null,
  };
}

describe('shouldGenerateWeeklyReview', () => {
  it('runs on the very first call (no weekly_reviews row yet), as long as there are labeled rows', () => {
    expect(shouldGenerateWeeklyReview(null, true, NOW)).toBe(true);
  });

  it('skips when the table is empty but there is nothing labeled yet either', () => {
    expect(shouldGenerateWeeklyReview(null, false, NOW)).toBe(false);
  });

  it('skips when the latest review is younger than 7 days, even with labeled rows present', () => {
    const latest = loadedReview(formatJakartaIso(new Date(NOW.getTime() - 6 * 24 * 3_600_000)));
    expect(shouldGenerateWeeklyReview(latest, true, NOW)).toBe(false);
  });

  it('skips when there are no labeled rows in the trailing window, even with a stale latest review', () => {
    const latest = loadedReview(formatJakartaIso(new Date(NOW.getTime() - 10 * 24 * 3_600_000)));
    expect(shouldGenerateWeeklyReview(latest, false, NOW)).toBe(false);
  });

  it('runs once the latest review is at least 7 days old and there are labeled rows', () => {
    const latest = loadedReview(formatJakartaIso(new Date(NOW.getTime() - 7 * 24 * 3_600_000)));
    expect(shouldGenerateWeeklyReview(latest, true, NOW)).toBe(true);
  });
});

describe('generateWeeklyReviewNarrative', () => {
  function fakeClient(completion: DeepSeekCompletion): DeepSeekClient {
    return { complete: vi.fn().mockResolvedValue(completion) };
  }

  const metrics: WeeklyReviewMetrics = computeWeeklyReviewMetrics(
    [],
    '2026-07-12T00:00:00+07:00',
    '2026-07-19T00:00:00+07:00',
  );

  it('trims whitespace and returns the completion model', async () => {
    const client = fakeClient({
      text: '  Long setups hit 55% of the time this week.  ',
      model: 'deepseek-v4-pro',
      output_tokens: 50,
      reasoning_tokens: 10,
    });

    const narration = await generateWeeklyReviewNarrative(client, metrics);

    expect(narration).toEqual({
      text: 'Long setups hit 55% of the time this week.',
      model: 'deepseek-v4-pro',
    });
  });

  it('sends the metrics object as the user message, JSON-encoded', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: 'ok',
      model: 'deepseek-v4-pro',
      output_tokens: 1,
      reasoning_tokens: 1,
    });
    await generateWeeklyReviewNarrative({ complete }, metrics);

    expect(complete).toHaveBeenCalledWith(expect.any(String), JSON.stringify(metrics));
  });

  it('rejects when the completion text is empty after trimming', async () => {
    const client = fakeClient({
      text: '   ',
      model: 'deepseek-v4-pro',
      output_tokens: null,
      reasoning_tokens: null,
    });

    await expect(generateWeeklyReviewNarrative(client, metrics)).rejects.toThrow();
  });
});
