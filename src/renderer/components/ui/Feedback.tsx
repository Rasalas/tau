import type { HTMLAttributes, ReactNode } from "react";

/** The ring Tau spins while something loads; `xs` is the 10 px of a status line, `lg` a panel's. */
export function Spinner({ size = "md", tone = "working", label = "Loading" }: {
  size?: "xs" | "sm" | "md" | "lg";
  /** `current` takes the text colour around it. */
  tone?: "working" | "accent" | "current";
  label?: string;
}) {
  return <span className={`spinner spinner-${size} tone-${tone}`} role="status" aria-label={label} />;
}

/** A placeholder in the shape of what is loading, so the layout does not jump when it arrives. */
export function Skeleton({ shape = "block", className, ...props }: HTMLAttributes<HTMLDivElement> & { shape?: "block" | "card" | "pill" }) {
  return <div aria-hidden="true" {...props} className={`skeleton ${shape}${className ? ` ${className}` : ""}`} />;
}

/**
 * What a surface says when it has nothing to show: an icon, a title, a line
 * of explanation and what to do about it. `compact` fits a card or a panel,
 * `hero` a whole page.
 */
export function Empty({ size = "default", icon, title, description, children }: {
  size?: "compact" | "default" | "hero";
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Actions, under the text. */
  children?: ReactNode;
}) {
  return (
    <div className={`empty-state ${size}`}>
      {icon ? <span className="empty-state-icon" aria-hidden="true">{icon}</span> : null}
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {children ? <div className="empty-state-actions">{children}</div> : null}
    </div>
  );
}
