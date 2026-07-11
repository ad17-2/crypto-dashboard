import { lookupQualityFlag } from '@/lib/copy';

export function QualityFlagChip({ flag }: { flag: string }) {
  const entry = lookupQualityFlag(flag);
  const tone =
    flag.includes('extreme') || flag.includes('invalid') || flag.includes('deviates')
      ? 'neg'
      : 'warn';
  // The chip carries the label + the bare value ("Extreme 24h volume move +1271.84%"); `detail`
  // spells the same value out as a sentence, which belongs in the tooltip, not glued to the label.
  const title = entry.detail ? `${entry.definition} ${entry.detail}` : entry.definition;
  return (
    <span className={`quality-flag-chip ${tone}`} title={title}>
      {entry.label}
      {entry.value ? <strong>&nbsp;{entry.value}</strong> : null}
    </span>
  );
}
