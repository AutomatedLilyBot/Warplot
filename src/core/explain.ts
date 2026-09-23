/**
 * Explanation / reason trees. Every mechanical conclusion the engine reaches
 * (legality, bounds, earliest times) carries one of these so the author can
 * see *why*, not just the number.
 */
export interface Explanation {
  label: string;
  /** Pass/fail for checks; undefined for purely informative nodes. */
  ok?: boolean;
  value?: number | string;
  /** Marks the limiting factor of a min()/max() style computation. */
  binding?: boolean;
  /** Event ids this reason relies on (causal references). */
  refs?: string[];
  children?: Explanation[];
}

export const check = (label: string, ok: boolean, extra: Partial<Explanation> = {}): Explanation => ({
  label,
  ok,
  ...extra,
});

export const info = (label: string, extra: Partial<Explanation> = {}): Explanation => ({ label, ...extra });

export const allOk = (xs: Explanation[]): boolean => xs.every((x) => x.ok !== false);

/** Render a reason tree as indented text (for logs / CLI / tests). */
export function renderExplanation(e: Explanation, indent = 0): string {
  const mark = e.ok === undefined ? '-' : e.ok ? '✓' : '✗';
  const val = e.value !== undefined ? `: ${e.value}` : '';
  const bind = e.binding ? '  [瓶颈/binding]' : '';
  const line = `${'  '.repeat(indent)}${mark} ${e.label}${val}${bind}`;
  return [line, ...(e.children ?? []).map((c) => renderExplanation(c, indent + 1))].join('\n');
}
