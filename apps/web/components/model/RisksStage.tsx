import type { ReactNode } from 'react';
import { InfoTip } from '@/components/ui/Tooltip';
import { lookupFactor, lookupMetric, lookupRegimeState } from '@/lib/copy';
import {
  type CollinearityRisk,
  collinearityRisks,
  oosIcSummary,
  REGIME_MIN_PERIODS,
  regimeIcSummary,
  walkForwardSummary,
} from '@/lib/model-health';

export interface RisksStageProps {
  /** untyped on the wire — read defensively. */
  modelWeights: unknown;
}

const VERDICT_PHRASE: Record<string, string> = {
  duplicate: 'are making essentially the same bet',
  redundant: 'are making largely the same bet',
  correlated: 'move together, though not identically',
};

/**
 * Stage 4: "What could be wrong" -- the honest risks in how the model is built right now:
 * factors double-counting the same idea, a regime-specific edge that isn't switched on yet,
 * out-of-sample results that mostly disagree with the in-sample story, and a robustness check
 * nothing has passed yet.
 */
export function RisksStage({ modelWeights }: RisksStageProps) {
  const collinearity = collinearityRisks(modelWeights);
  const regime = regimeIcSummary(modelWeights);
  const oos = oosIcSummary(modelWeights);
  const walkForward = walkForwardSummary(modelWeights);

  return (
    <section className="stage" aria-label="What could be wrong">
      <p className="stage-eyebrow m-0">What could be wrong</p>
      <h3 className="stage-title mt-2 mb-1">Reasons to stay skeptical</h3>
      <p className="text-muted text-[13px] max-w-[62ch]">
        This is the point of this page: the honest gaps in how today's ranking was built, not just
        the parts that look good.
      </p>

      <div className="mt-6 grid gap-8">
        <RiskBlock
          title="Two factors are betting on the same thing"
          term="Collinearity"
          definition={lookupMetric('collinearity').definition}
        >
          <CollinearityBody risks={collinearity} />
        </RiskBlock>

        <RiskBlock
          title="Regime-specific edge isn't switched on"
          term="Regime-conditional IC"
          definition={lookupMetric('regime_conditional_ic').definition}
        >
          <RegimeIcBody
            activeCount={regime.activeCount}
            totalCount={regime.totalCount}
            typicalPeriods={regime.typicalPeriods}
            regimeLabel={regime.regimeLabel}
          />
        </RiskBlock>

        <RiskBlock
          title="Out-of-sample results mostly disagree"
          term="Out-of-sample"
          definition={lookupMetric('out_of_sample').definition}
        >
          <OosIcBody negativeCount={oos.negativeCount} totalCount={oos.totalCount} />
        </RiskBlock>

        <RiskBlock
          title="Nothing has proven itself out of sample yet"
          term="Robustness"
          definition={lookupMetric('robustness').definition}
        >
          <RobustnessBody
            robustCount={walkForward.robustCount}
            overfitCount={walkForward.overfitCount}
            totalCount={walkForward.totalCount}
          />
        </RiskBlock>
      </div>
    </section>
  );
}

function RiskBlock({
  title,
  term,
  definition,
  children,
}: {
  title: string;
  term: string;
  definition: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h4 className="flex items-center gap-1.5 m-0 text-[14px] font-semibold text-ink">
        {title}
        <InfoTip term={term} definition={definition} />
      </h4>
      <div className="mt-2 text-[13px] text-muted leading-snug max-w-[68ch]">{children}</div>
    </div>
  );
}

function CollinearityBody({ risks }: { risks: CollinearityRisk[] }) {
  if (risks.length === 0) {
    return <p className="m-0">No two factors are moving together closely enough to flag.</p>;
  }
  return (
    <div className="grid gap-2.5">
      {risks.map((risk) => {
        const labelA = lookupFactor(risk.a).label;
        const labelB = lookupFactor(risk.b).label;
        const phrase = (risk.verdict && VERDICT_PHRASE[risk.verdict]) || 'are related';
        const bothTopTwo =
          risk.aRank !== null && risk.bRank !== null && risk.aRank <= 2 && risk.bRank <= 2;
        return (
          <p key={`${risk.a}-${risk.b}`} className="m-0">
            <strong className="text-ink">{labelA}</strong> and{' '}
            <strong className="text-ink">{labelB}</strong> {phrase}
            {risk.rho !== null ? ` (rho ${risk.rho.toFixed(2)})` : ''}. Counting both means this one
            idea gets weighted twice, not two independent ideas.
            {bothTopTwo && risk.combinedWeightPct !== null ? (
              <>
                {' '}
                These two alone are the model's <strong className="text-ink">largest two</strong>{' '}
                weights — together about{' '}
                <strong className="text-ink">{risk.combinedWeightPct.toFixed(0)}%</strong> of its
                total weight.
              </>
            ) : null}
          </p>
        );
      })}
    </div>
  );
}

function RegimeIcBody({
  activeCount,
  totalCount,
  typicalPeriods,
  regimeLabel,
}: {
  activeCount: number;
  totalCount: number;
  typicalPeriods: number | null;
  regimeLabel: string | null;
}) {
  if (totalCount === 0) {
    return <p className="m-0">No regime-conditional data for this run.</p>;
  }
  const regime = lookupRegimeState(regimeLabel);
  if (activeCount > 0) {
    return (
      <p className="m-0">
        {activeCount} of {totalCount} factors are currently using a regime-specific edge, measured
        only from snapshots taken while the market was in the current regime ({regime.label}).
      </p>
    );
  }
  return (
    <p className="m-0">
      The model can measure each factor's edge separately for the current regime ({regime.label})
      instead of pooling every regime together — but that needs at least {REGIME_MIN_PERIODS}{' '}
      snapshots from within this regime, and there {typicalPeriods === 1 ? 'is' : 'are'} only{' '}
      {typicalPeriods ?? 'a handful of'} so far. So all {totalCount} factors fall back to the
      pooled, all-regime numbers instead.
    </p>
  );
}

function OosIcBody({ negativeCount, totalCount }: { negativeCount: number; totalCount: number }) {
  if (totalCount === 0) {
    return <p className="m-0">No out-of-sample readings for this run.</p>;
  }
  const majority = negativeCount > totalCount / 2;
  return (
    <p className="m-0">
      {negativeCount} of {totalCount} factors had a negative out-of-sample reading —{' '}
      {majority ? 'most' : 'some'} of the model's factors look worse, not better, once checked
      against data they weren't measured on.
    </p>
  );
}

function RobustnessBody({
  robustCount,
  overfitCount,
  totalCount,
}: {
  robustCount: number;
  overfitCount: number;
  totalCount: number;
}) {
  if (totalCount === 0) {
    return <p className="m-0">No robustness data for this run.</p>;
  }
  if (robustCount === 0) {
    const rest =
      overfitCount === 0
        ? 'none of them even showed an edge strong enough to test in the first place'
        : `${overfitCount} of them reversed once tested on data ${overfitCount === 1 ? 'it' : 'they'} weren't measured on, and the rest never showed an edge strong enough to test in the first place`;
    return (
      <p className="m-0">
        None of the {totalCount} factors have passed the walk-forward robustness check yet — {rest}.
      </p>
    );
  }
  return (
    <p className="m-0">
      {robustCount} of {totalCount} factors have passed the walk-forward robustness check so far.
    </p>
  );
}
