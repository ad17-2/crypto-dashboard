'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { triggerRefresh } from '@/lib/actions';

/**
 * Triggers a backend refresh (POST /api/refresh via the triggerRefresh server action), then asks
 * Next.js to re-render this server component tree so the freshly reported refresh_status shows up.
 * The pipeline run itself is async on the API side, so the dashboard rows won't update
 * instantly — this mirrors what /api/refresh actually guarantees (a 202 acknowledgement).
 */
export function ReloadButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await triggerRefresh();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1 max-[680px]:w-full">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="h-9 border border-line bg-panel text-ink rounded-md px-2.5 text-[13px] cursor-pointer font-semibold max-[680px]:w-full disabled:cursor-wait disabled:opacity-60"
      >
        {isPending ? 'Reloading…' : 'Reload'}
      </button>
      {error ? <span className="text-down text-xs">{error}</span> : null}
    </span>
  );
}
