import type { WeeklyReview } from '@crypto-screener/contracts';
import { describe, expect, it } from 'vitest';
import { parseWeeklyReview } from '../lib/weekly-review';
import { NO_LEAKED_VALUES } from './noLeakedValues';

function review(overrides: Partial<WeeklyReview> = {}): WeeklyReview {
  return {
    generated_at: '2026-07-19T00:00:00+07:00',
    week_start: '2026-07-12T00:00:00+07:00',
    week_end: '2026-07-19T00:00:00+07:00',
    metrics: {
      side_hit_rates: [
        {
          side: 'long',
          horizon_hours: 24,
          hit_rate_raw: 0.58,
          n_raw: 40,
          hit_rate_residual: 0.5,
          n_residual: 40,
        },
        {
          side: 'short',
          horizon_hours: 24,
          hit_rate_raw: null,
          n_raw: 0,
          hit_rate_residual: null,
          n_residual: 0,
        },
      ],
    },
    narrative: 'Long setups hit about 58% of the time this week, n=40.',
    model: 'deepseek-v4-pro',
    ...overrides,
  };
}

describe('parseWeeklyReview', () => {
  it('parses a well-formed weekly_review', () => {
    const parsed = parseWeeklyReview(review());

    expect(parsed?.narrative).toBe('Long setups hit about 58% of the time this week, n=40.');
    expect(parsed?.model).toBe('deepseek-v4-pro');
    expect(parsed?.generatedAt).toBe('2026-07-19T00:00:00+07:00');
    expect(parsed?.weekStart).toBe('2026-07-12T00:00:00+07:00');
    expect(parsed?.weekEnd).toBe('2026-07-19T00:00:00+07:00');
  });

  it('returns null when weekly_review is absent (no computation has ever run)', () => {
    expect(parseWeeklyReview(null)).toBeNull();
    expect(parseWeeklyReview(undefined)).toBeNull();
  });

  it('trims and caps the narrative, mirroring lib/briefing.ts', () => {
    const spaced = parseWeeklyReview(review({ narrative: '  spaced out  ' }));
    expect(spaced?.narrative).toBe('spaced out');

    const longText = 'a'.repeat(2000);
    const capped = parseWeeklyReview(review({ narrative: longText }));
    expect(capped?.narrative).toHaveLength(1801);
    expect(capped?.narrative?.endsWith('…')).toBe(true);
  });

  it('renders facts-only when narrative is null (metrics-only, narration skipped or failed)', () => {
    const parsed = parseWeeklyReview(review({ narrative: null, model: null }));

    expect(parsed).not.toBeNull();
    expect(parsed?.narrative).toBeNull();
    expect(parsed?.model).toBeNull();
    expect(parsed?.facts.length).toBeGreaterThan(0);
  });

  it('treats a blank narrative the same as null', () => {
    const parsed = parseWeeklyReview(review({ narrative: '   ' }));
    expect(parsed?.narrative).toBeNull();
  });

  it('builds one fact per side_hit_rates entry, formatting the hit rate as a rounded percentage', () => {
    const parsed = parseWeeklyReview(review());

    expect(parsed?.facts).toEqual([
      { label: 'long 24h', value: '58% (n=40)' },
      { label: 'short 24h', value: '— (n=0)' },
    ]);
  });

  it('skips a side_hit_rates entry missing a field it needs, without throwing', () => {
    const parsed = parseWeeklyReview(
      review({
        metrics: {
          side_hit_rates: [
            { side: 'long', horizon_hours: 24, hit_rate_raw: 0.5, n_raw: 10 },
            { side: 'short' }, // missing horizon_hours/n_raw
            'not-an-object',
          ],
        },
      }),
    );

    expect(parsed?.facts).toEqual([{ label: 'long 24h', value: '50% (n=10)' }]);
  });

  it('returns null (nothing to show) when both narrative and facts are absent', () => {
    const parsed = parseWeeklyReview(review({ narrative: null, metrics: {} }));
    expect(parsed).toBeNull();
  });

  it('returns null when metrics.side_hit_rates is missing or malformed', () => {
    expect(
      parseWeeklyReview(review({ narrative: null, metrics: { side_hit_rates: 'nope' } })),
    ).toBeNull();
    expect(
      parseWeeklyReview(
        review({ narrative: null, metrics: null as unknown as Record<string, unknown> }),
      ),
    ).toBeNull();
  });

  it('never leaks null/NaN/undefined into the rendered narrative or facts', () => {
    const parsed = parseWeeklyReview(review());
    const rendered = [
      parsed?.narrative,
      parsed?.model,
      ...(parsed?.facts.map((fact) => `${fact.label} ${fact.value}`) ?? []),
    ].join('\n');

    expect(rendered).not.toMatch(NO_LEAKED_VALUES);
  });
});
