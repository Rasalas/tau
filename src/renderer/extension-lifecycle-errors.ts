import { errorMessage } from "../workbench/error-message";

/** Keep one failure intact; surface every message when cleanup has several. */
export function throwFailures(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map(errorMessage).join("; "));
}

/** Finish every callback before surfacing failures from lifecycle work. */
export function runAll(callbacks: Iterable<() => void>): void {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try { callback(); } catch (error) { errors.push(error); }
  }
  throwFailures(errors);
}
