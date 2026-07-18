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

  const headerClassName = 'flex justify-between items-baseline gap-2 pb-2.5 border-b border-line';

  const metaClassName = 'text-ash text-xs font-mono tabular-nums';

  return (
    <section id={id} className={shellClassName} {...rest}>
      <div className={headerClassName}>
        <h2 className="label m-0">{title}</h2>
        {meta !== undefined ? <span className={metaClassName}>{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}
