import type { Freshness, RunSummary } from '@crypto-screener/contracts';
import { Panel } from '@/components/layout/Panel';
import { fmtNum } from '@/lib/format';

export interface FreshnessPanelProps {
  freshness: Freshness;
  runs: RunSummary[];
}

/** Ports freshnessBlock() + runsBlock() from dashboard.js (shown together as one panel). */
export function FreshnessPanel({ freshness, runs }: FreshnessPanelProps) {
  const meta = freshness.label || `${runs.length} loaded`;

  return (
    <Panel title="Freshness / Runs" meta={meta} accent="blue">
      <FreshnessBlock freshness={freshness} />
      <RunsBlock runs={runs} />
    </Panel>
  );
}

function FreshnessBlock({ freshness }: { freshness: Freshness }) {
  if (freshness.status !== 'ok') {
    return (
      <div className="list p-3 grid gap-2">
        <Row label="Freshness" value="unknown" />
      </div>
    );
  }
  return (
    <div className="list freshness-list p-3 grid gap-2 border-b border-line">
      <Row label="Selected Run" value={freshness.generated_at || '-'} />
      <Row
        label="Age"
        value={`${freshness.label || 'unknown'} / ${fmtNum(freshness.age_minutes, 1)}m`}
      />
    </div>
  );
}

function RunsBlock({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return <div className="py-7 px-3 text-muted text-center">No runs</div>;
  }
  return (
    <div className="list p-3 grid gap-2">
      {runs.slice(0, 12).map((run) => (
        <Row
          key={run.run_id}
          label={run.generated_at}
          value={`${run.bias} / ${run.coinglass_status} / ${run.row_count} rows`}
        />
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="list-row flex justify-between gap-3 text-[13px]">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}
