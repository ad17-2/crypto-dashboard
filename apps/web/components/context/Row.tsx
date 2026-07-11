import type { ReactNode } from 'react';

/** A label/value line used across the bottom context panels (Freshness, Sector Rotation, Validation). */
export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="list-row flex justify-between gap-3 text-[13px]">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}
