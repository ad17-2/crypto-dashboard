import { Panel } from '@/components/layout/Panel';

export interface ProvidersPanelProps {
  /** Untyped on the wire (crypto_screener/dashboard_payload.py::_provider_status). */
  providerStatus: Record<string, unknown>;
}

interface ProviderEntry {
  status: string;
  rows?: number | undefined;
}

/** Ports providerList() + renderSideModules()'s provider-issue header logic from dashboard.js. */
export function ProvidersPanel({ providerStatus }: ProvidersPanelProps) {
  const entries = Object.entries(providerStatus);
  const hasIssue = entries.some(([, raw]) => asProviderEntry(raw).status !== 'ok');
  const meta = hasIssue ? 'needs attention' : `${entries.length} ok`;

  return (
    <Panel title="Providers" meta={meta} accent="blue">
      {entries.length === 0 ? (
        <div className="py-7 px-3 text-muted text-center">No providers</div>
      ) : (
        <div className="provider-list p-3 grid gap-2">
          {entries.map(([name, raw]) => {
            const details = asProviderEntry(raw);
            const tone =
              details.status === 'ok'
                ? ''
                : details.status === 'skipped' || details.status === 'disabled'
                  ? 'warn'
                  : 'bad';
            return (
              <div
                key={name}
                className="provider-row grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 items-center min-h-[30px] text-[13px]"
              >
                <strong>{name}</strong>
                <span className={`status-pill ${tone}`}>{details.status}</span>
                <span className="provider-count text-muted text-xs font-mono text-right min-w-[38px]">
                  {details.rows === undefined ? '-' : details.rows}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function asProviderEntry(value: unknown): ProviderEntry {
  if (typeof value !== 'object' || value === null) {
    return { status: '-' };
  }
  const record = value as Record<string, unknown>;
  return {
    status: typeof record.status === 'string' ? record.status : '-',
    rows: typeof record.rows === 'number' ? record.rows : undefined,
  };
}
