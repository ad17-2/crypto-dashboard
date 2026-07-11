import { InfoTip, Term } from '@/components/ui/Tooltip';
import { lookupFactor, lookupMetric } from '@/lib/copy';
import {
  decaySummary,
  type FactorHitRate,
  factorHitRates,
  walkForwardSummary,
} from '@/lib/model-health';

export interface EvidenceStageProps {
  /** untyped on the wire — read defensively. */
  validation: unknown;
  /** untyped on the wire — read defensively. */
  modelWeights: unknown;
}

const BASELINE_PCT = 50;
/** Percentage points of hit-rate deviation from the 50% baseline that fill half the track. */
const DEVIATION_SCALE = 8;

/**
 * Stage 3: "Is it working?" -- factor hit rates against a coin-flip baseline, how fast a
 * signal's edge decays, and whether the walk-forward (train-then-test) check has found anything
 * that holds up yet.
 */
export function EvidenceStage({ validation, modelWeights }: EvidenceStageProps) {
  const hitRates = factorHitRates(validation);
  const decay = decaySummary(modelWeights);
  const walkForward = walkForwardSummary(modelWeights);

  return (
    <section className="stage" aria-label="Is it working?">
      <p className="stage-eyebrow m-0">Is it working?</p>
      <h3 className="stage-title mt-2 mb-1">
        <Term label="Hit rates" definition={lookupMetric('hit_rate').definition} /> vs. a coin flip
      </h3>
      <p className="text-muted text-[13px] max-w-[62ch]">
        A coin flip is 50%. These edges are small by design — a factor claiming 60% would be
        suspicious, not exciting.
      </p>

      {hitRates.length === 0 ? (
        <p className="text-muted text-[13px] mt-4">No factor hit rates for this run.</p>
      ) : (
        <div className="mt-6 grid gap-1">
          {hitRates.map((rate, index) => (
            <HitRateRow
              key={rate.name}
              rate={rate}
              isBest={index === 0}
              isWeakest={index === hitRates.length - 1}
            />
          ))}
        </div>
      )}

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <div>
          <h4 className="flex items-center gap-1.5 m-0 text-[14px] font-semibold text-ink">
            Signal decay
            <InfoTip
              term="Decay"
              definition={`${lookupMetric('decay').definition} ${lookupMetric('half_life').definition}`}
            />
          </h4>
          <p className="mt-2 text-[13px] text-muted leading-snug">
            <DecaySentence
              sufficientCount={decay.sufficientCount}
              totalCount={decay.totalCount}
              medianPeakHours={decay.medianPeakHours}
              holdsFactorCount={decay.holdsFactorCount}
              medianHoldsHours={decay.medianHoldsHours}
            />
          </p>
        </div>
        <div>
          <h4 className="flex items-center gap-1.5 m-0 text-[14px] font-semibold text-ink">
            Walk-forward test
            <InfoTip
              term="Walk-forward test"
              definition={lookupMetric('walk_forward').definition}
            />
          </h4>
          <p className="mt-2 text-[13px] text-muted leading-snug">
            <WalkForwardSentence
              trainPeriods={walkForward.trainPeriods}
              testPeriods={walkForward.testPeriods}
              robustCount={walkForward.robustCount}
              overfitCount={walkForward.overfitCount}
              insufficientCount={walkForward.insufficientCount}
              totalCount={walkForward.totalCount}
            />
          </p>
        </div>
      </div>
    </section>
  );
}

function HitRateRow({
  rate,
  isBest,
  isWeakest,
}: {
  rate: FactorHitRate;
  isBest: boolean;
  isWeakest: boolean;
}) {
  const factor = lookupFactor(rate.name);
  const hitRate = rate.hitRate;
  const delta =
    hitRate === null
      ? 0
      : Math.max(-DEVIATION_SCALE, Math.min(DEVIATION_SCALE, hitRate - BASELINE_PCT));
  const fillWidthPct = (Math.abs(delta) / DEVIATION_SCALE) * 50;
  const tone = delta >= 0 ? 'pos' : 'neg';
  const fillStyle =
    delta >= 0
      ? { left: '50%', width: `${fillWidthPct}%` }
      : { left: `${50 - fillWidthPct}%`, width: `${fillWidthPct}%` };

  return (
    <div className="hitrate-row">
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate text-[12.5px] text-ink" title={factor.label}>
          {factor.label}
        </span>
        {isBest ? <span className="status-pill neutral shrink-0">Best</span> : null}
        {isWeakest ? <span className="status-pill neutral shrink-0">Weakest</span> : null}
      </span>
      <span className="hitrate-track" aria-hidden="true">
        <span className="hitrate-baseline" />
        {hitRate !== null ? <span className={`hitrate-fill ${tone}`} style={fillStyle} /> : null}
      </span>
      <span className="font-mono tabular-nums text-[12.5px] text-muted text-right">
        {hitRate === null ? '-' : `${hitRate.toFixed(1)}%`}
      </span>
    </div>
  );
}

/**
 * medianPeakHours and medianHoldsHours are two SEPARATE medians over two different subsets of
 * factors (see decaySummary's doc comment in lib/model-health.ts) -- they must never be joined
 * into one "peaks at X, then fades by Y" clause, since Y can land before X for real data (most
 * factors here don't fade within the 72h window tested, so the ones that do skew toward an
 * earlier peak). Reported as two separate, clearly-scoped sentences instead.
 */
function DecaySentence({
  sufficientCount,
  totalCount,
  medianPeakHours,
  holdsFactorCount,
  medianHoldsHours,
}: {
  sufficientCount: number;
  totalCount: number;
  medianPeakHours: number | null;
  holdsFactorCount: number;
  medianHoldsHours: number | null;
}) {
  if (totalCount === 0) return <>No decay data for this run.</>;
  if (sufficientCount === 0 || medianPeakHours === null) {
    return (
      <>
        None of the {totalCount} factors have enough history yet to read how their signal decays
        over time.
      </>
    );
  }
  const fadeSentence =
    holdsFactorCount === 0 || medianHoldsHours === null
      ? " None of them have faded to half that peak strength within the 72h window tested — each one's edge holds up for as long as the window tested."
      : ` Of those, ${holdsFactorCount} have measurably faded to half their own peak strength within the window tested — typically by around ${medianHoldsHours}h after firing.`;
  return (
    <>
      Across the {sufficientCount} of {totalCount} factors with enough history to tell, the typical
      signal is strongest around {medianPeakHours}h after it fires.
      {fadeSentence}
    </>
  );
}

function WalkForwardSentence({
  trainPeriods,
  testPeriods,
  robustCount,
  overfitCount,
  insufficientCount,
  totalCount,
}: {
  trainPeriods: number | null;
  testPeriods: number | null;
  robustCount: number;
  overfitCount: number;
  insufficientCount: number;
  totalCount: number;
}) {
  if (totalCount === 0 || trainPeriods === null || testPeriods === null) {
    return <>No walk-forward test has run for this data yet.</>;
  }
  const heldUpText =
    robustCount === 0
      ? 'None of them have held up yet.'
      : `${robustCount} of ${totalCount} held up.`;
  return (
    <>
      The model trains on the earlier {trainPeriods} time snapshots, then checks each factor against
      the later {testPeriods} it never trained on. {heldUpText} {overfitCount} reversed or vanished
      on that unseen data, and {insufficientCount} never showed an edge strong enough to test in the
      first place.
    </>
  );
}
