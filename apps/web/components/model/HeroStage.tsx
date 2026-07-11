import { evidenceLadder, modelHealthVerdict } from '@/lib/model-health';
import { EvidenceLadder } from './EvidenceLadder';

export interface HeroStageProps {
  /** untyped on the wire — read defensively. */
  quality: unknown;
  /** untyped on the wire — read defensively. */
  validation: unknown;
  /** untyped on the wire — read defensively. */
  modelWeights: unknown;
}

/**
 * The hero: "Can I trust today's ranking?" A computed plain-English verdict, then the evidence
 * ladder -- four ascending claims the model would like to make about itself, each lit only if
 * the real numbers back it up. A reader who stops right here still knows the answer.
 */
export function HeroStage({ quality, validation, modelWeights }: HeroStageProps) {
  const payloadLike = { quality, validation, model_weights: modelWeights };
  const verdict = modelHealthVerdict(payloadLike);
  const rungs = evidenceLadder(payloadLike);

  return (
    <section className="stage" aria-label="Can I trust today's ranking?">
      <h2 className="stage-eyebrow m-0">Can I trust today's ranking?</h2>
      <h3 className="verdict m-0 mt-2">{verdict.headline}</h3>
      <p className="verdict-sub">{verdict.summary}</p>

      <div className="mt-8">
        <EvidenceLadder rungs={rungs} />
      </div>
    </section>
  );
}
