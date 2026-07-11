import type { ReactNode } from 'react';
import { Panel } from '@/components/layout/Panel';
import { fmtNum, fmtRate } from '@/lib/format';

export interface ValidationPanelProps {
  /** Untyped on the wire (crypto_screener/dashboard_payload.py::_validation_summary). */
  validation: Record<string, unknown>;
}

interface FactorHitRate {
  label: string;
  hit_rate: unknown;
}

interface ConflictBucket {
  label: string;
  count: unknown;
  avg_confidence: unknown;
}

/**
 * Ports validationBlock() from dashboard.js: Status / Observations / Model Hit / Best Factor /
 * Weak Factor rows, then the "Current Signal Mix" conflict-bucket sub-table (first 4 buckets).
 */
export function ValidationPanel({ validation }: ValidationPanelProps) {
  const hasData = Object.keys(validation).length > 0;
  const status = asString(validation.status);
  const calibrationLabel = asString(validation.calibration_label);
  const meta = calibrationLabel || status || 'unknown';
  const best = asFactorHitRate(asArray(validation.best_factors)[0]);
  const weak = asFactorHitRate(asArray(validation.weakest_factors)[0]);
  const buckets = asArray(validation.conflict_buckets)
    .map(asConflictBucket)
    .filter((bucket): bucket is ConflictBucket => bucket !== null)
    .slice(0, 4);

  return (
    <Panel title="Validation" meta={meta} accent="blue">
      {!hasData ? (
        <div className="py-7 px-3 text-muted text-center">No validation data</div>
      ) : (
        <div className="list p-3 grid gap-2">
          <Row
            label="Status"
            value={`${status || 'unknown'} / ${calibrationLabel || 'learning'}`}
          />
          <Row
            label="Observations"
            value={`${String(validation.observations ?? 0)} / ${String(validation.horizon_hours ?? '-')}h`}
          />
          <Row label="Model Hit" value={fmtRate(validation.model_hit_rate)} />
          <Row label="Best Factor" value={best ? `${best.label} ${fmtRate(best.hit_rate)}` : '-'} />
          <Row label="Weak Factor" value={weak ? `${weak.label} ${fmtRate(weak.hit_rate)}` : '-'} />
          <div className="label">Current Signal Mix</div>
          {buckets.length === 0 ? (
            <div className="py-7 px-3 text-muted text-center">No signal buckets</div>
          ) : (
            buckets.map((bucket) => (
              <Row
                key={bucket.label}
                label={bucket.label}
                value={`${String(bucket.count)} / C ${fmtNum(bucket.avg_confidence, 0)}`}
              />
            ))
          )}
        </div>
      )}
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="list-row flex justify-between gap-3 text-[13px]">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asFactorHitRate(value: unknown): FactorHitRate | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return { label: asString(record.label) || '-', hit_rate: record.hit_rate };
}

function asConflictBucket(value: unknown): ConflictBucket | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    label: asString(record.label) || '-',
    count: record.count,
    avg_confidence: record.avg_confidence,
  };
}
