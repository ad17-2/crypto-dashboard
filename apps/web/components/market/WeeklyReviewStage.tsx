import type { WeeklyReview } from '@crypto-screener/contracts';
import { parseWeeklyReview } from '@/lib/weekly-review';

export interface WeeklyReviewStageProps {
  weeklyReview: WeeklyReview | null | undefined;
}

/**
 * Facts (hit rates + n) render whenever a computation exists, with or without a narrative --
 * narration can fail or be skipped (no DEEPSEEK_API_KEY) while the metrics still get persisted;
 * see apps/api's refresh/runtime.ts attachWeeklyReview. Renders nothing before the first
 * computation ever runs.
 */
export function WeeklyReviewStage({ weeklyReview }: WeeklyReviewStageProps) {
  const parsed = parseWeeklyReview(weeklyReview);
  if (parsed === null) return null;

  return (
    <section className="stage" aria-label="Weekly review">
      <h2 className="stage-eyebrow m-0">Weekly review</h2>
      <h3 className="stage-title mt-2 mb-0">
        {parsed.weekStart.slice(0, 10)} – {parsed.weekEnd.slice(0, 10)}
      </h3>
      {parsed.narrative ? <p className="verdict-sub mt-2">{parsed.narrative}</p> : null}
      {parsed.facts.length > 0 ? (
        <p className="mt-3 text-ash text-xs font-mono">
          {parsed.facts.map((fact) => `${fact.label} ${fact.value}`).join(' · ')}
        </p>
      ) : null}
    </section>
  );
}
