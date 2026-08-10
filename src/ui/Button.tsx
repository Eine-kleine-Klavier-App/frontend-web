import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
}

/** The ONE text/labeled-action button primitive (DESIGN.md §7: primary/secondary/ghost/icon),
 *  shared across every browse surface — no screen invents its own button CSS. `.btn` carries the
 *  shape (height/radius/padding/press-feedback per §3.5's CSS micro-feedback layer); `.btn-{variant}`
 *  carries only color. The editor's SQUARE icon-only controls stay on `.icon-btn` on purpose — a
 *  different shape for a different job (toolbar actions, not labeled CTAs) — this component is not
 *  force-fit onto them. */
export function Button({ variant = 'secondary', icon, className = '', children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`btn btn-${variant} ${className}`} {...rest}>
      {icon}
      {children}
    </button>
  );
}
