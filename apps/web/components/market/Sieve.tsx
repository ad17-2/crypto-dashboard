'use client';

import type { SieveStage } from '@/lib/verdict';

export interface SieveProps {
  stages: SieveStage[];
}

/**
 * DOM id of the coin table this stage's final segment scrolls to. Owned by whatever renders the
 * screened-coins table (page.tsx / components/watchlist) — that element must carry this id for
 * the button below to do anything.
 */
const SCREENED_COINS_ID = 'screened-coins';

/**
 * Jump to the coin table.
 *
 * Deliberately not a bare `scrollIntoView({behavior: 'smooth'})`: some Chrome builds accept that
 * call and silently never scroll, which makes the button look wired up while doing nothing. So we
 * ask for smooth, then check we actually moved and hard-jump if we didn't. Honours reduced-motion.
 */
function scrollToScreenedCoins(): void {
  const target = document.getElementById(SCREENED_COINS_ID);
  if (!target) return;

  const top = target.getBoundingClientRect().top + window.scrollY;
  const startY = window.scrollY;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });

  if (reduceMotion) return;
  window.setTimeout(() => {
    if (window.scrollY === startY) window.scrollTo(0, top);
  }, 250);
}

/**
 * The signature funnel, told as text: real pipeline counts (scanned -> priced -> trusted ->
 * shortlisted) joined by ash arrows, e.g. "80 scanned -> 50 priced -> 50 trusted -> 11
 * shortlisted". Client component only because the final segment needs an onClick -- everything
 * else about the stage (verdict, stat tiles) stays server-rendered.
 */
export function Sieve({ stages }: SieveProps) {
  if (stages.length === 0) return null;

  return (
    <fieldset
      className="sieve m-0 border-0 p-0"
      aria-label="Screening funnel, scanned to shortlisted"
    >
      {stages.map((stage, index) => (
        <span key={stage.key}>
          {index > 0 ? (
            <span className="mx-2 text-ash" aria-hidden="true">
              &rarr;
            </span>
          ) : null}
          {stage.key === 'shortlisted' ? (
            <button
              type="button"
              className="link cursor-pointer bg-transparent border-0 p-0"
              onClick={scrollToScreenedCoins}
            >
              <span className="tabular-nums">{stage.count}</span>{' '}
              <span className="lowercase">{stage.label}</span>
            </button>
          ) : (
            <>
              <span className="tabular-nums">{stage.count}</span>{' '}
              <span className="lowercase">{stage.label}</span>
            </>
          )}
        </span>
      ))}
    </fieldset>
  );
}
