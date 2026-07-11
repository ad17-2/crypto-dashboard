import type { Quality } from '@crypto-screener/contracts';
import { Panel } from '@/components/layout/Panel';
import { fmtPct } from '@/lib/format';

export interface DataQualityPanelProps {
  quality: Quality;
}

/** Flag-code -> short label + tone, ported from qualityFlagChip() in dashboard.js. */
const FLAG_LABELS: Record<string, string> = {
  extreme_24h_price_change: 'Price 24h',
  extreme_24h_oi_change: 'OI 24h',
  extreme_24h_volume_change: 'Volume 24h',
  extreme_funding_rate: 'Funding',
  thin_coinglass_exchange_coverage: 'Thin coverage',
  price_deviates_from_index: 'Price vs Index',
  price_deviates_from_binance: 'Price vs Binance',
  stale_low_quote_volume: 'Low volume',
  invalid_price: 'Invalid price',
  invalid_open_interest: 'Invalid OI',
  weird_symbol: 'Symbol',
  weird_contract_symbol: 'Contract',
};

/** Ports qualityBlock() from dashboard.js: an "All clear" row, or one card per flagged row. */
export function DataQualityPanel({ quality }: DataQualityPanelProps) {
  const flags = quality.flagged_rows;

  return (
    <Panel title="Data Quality" meta={`${quality.excluded_count} excluded`} accent="blue">
      <div className="quality-flags p-3 grid gap-2.5">
        {flags.length === 0 ? (
          <div className="quality-card grid gap-1.5 p-2 rounded-md">
            <div className="quality-card-head flex justify-between gap-2 items-baseline text-[13px]">
              <strong>All clear</strong>
              <span>sanity checks passed</span>
            </div>
          </div>
        ) : (
          flags.map((row) => (
            <div
              key={`${row.symbol ?? 'unknown'}-${row.data_source ?? 'unknown'}`}
              className="quality-card grid gap-1.5 p-2 rounded-md"
            >
              <div className="quality-card-head flex justify-between gap-2 items-baseline text-[13px]">
                <strong>{row.symbol ?? '-'}</strong>
                <span>
                  {fmtPct(row.price_change_24h_pct)} / OI {fmtPct(row.oi_change_24h_pct)}
                </span>
              </div>
              <div className="quality-flag-list flex flex-wrap gap-1">
                {row.flags.map((flag) => (
                  <QualityFlagChip key={flag} flag={flag} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function QualityFlagChip({ flag }: { flag: string }) {
  const parts = flag.split(':');
  const rawLabel = parts[0] ?? flag;
  const rawValue = parts[1] ?? '';
  const label = FLAG_LABELS[rawLabel] ?? rawLabel.replace(/_/g, ' ');
  const tone =
    rawLabel.includes('extreme') || rawLabel.includes('invalid') || rawLabel.includes('deviates')
      ? 'bad'
      : 'warn';
  return (
    <span className={`quality-flag-chip ${tone}`} title={flag}>
      {label}
      {rawValue ? <strong> {rawValue}</strong> : null}
    </span>
  );
}
