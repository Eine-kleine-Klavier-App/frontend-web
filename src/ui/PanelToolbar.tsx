import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/** Fixed header outside a panel's scrollport; controls travel with its surface. */
export function PanelToolbar({ label, children, className = '' }: { label: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`panel-toolbar ${className}`}>
      <span className="panel-toolbar-label">{label}</span>
      <div className="panel-toolbar-controls">{children}</div>
    </div>
  );
}

export const PanelToolbarControl = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function PanelToolbarControl({ className = '', children, ...props }, ref) {
    return (
      <button {...props} ref={ref} type="button" className={`icon-btn panel-toolbar-control ${className}`}>
        {children}
      </button>
    );
  },
);
