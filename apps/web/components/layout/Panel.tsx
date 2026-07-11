import type { ReactNode } from 'react';

export interface PanelProps {
  title: string;
  meta?: ReactNode;
  id?: string;
  'aria-label'?: string;
  className?: string;
  children: ReactNode;
}

export function Panel({ title, meta, id, className, children, ...rest }: PanelProps) {
  const shellClassName = ['panel', className].filter(Boolean).join(' ');

  const headerClassName =
    'flex justify-between items-center gap-2 min-h-[42px] px-3 py-2.5 bg-panel-2 border-b border-line';

  const metaClassName = 'text-muted text-xs font-mono tabular-nums';

  return (
    <section id={id} className={shellClassName} {...rest}>
      <div className={headerClassName}>
        <h2 className="m-0 text-xs font-semibold uppercase tracking-wide">{title}</h2>
        {meta !== undefined ? <span className={metaClassName}>{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}
