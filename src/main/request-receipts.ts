/** How many recent submissions per scope a retry can still find. */
const RECEIPTS_PER_SCOPE = 256;

/** Answers a repeated client submission with the first one's result instead of running it twice. */
export class RequestReceipts<T> {
  private readonly scopes = new Map<string, Map<string, Promise<T>>>();

  run(scope: string, id: string | undefined, submit: () => Promise<T>): Promise<T> {
    if (!id) return submit();
    let receipts = this.scopes.get(scope);
    if (!receipts) {
      receipts = new Map();
      this.scopes.set(scope, receipts);
    }
    const existing = receipts.get(id);
    if (existing) return existing;
    // Register before submission can prepare, bind or create a runtime.
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const receipt = new Promise<T>((accepted, rejected) => { resolve = accepted; reject = rejected; });
    receipts.set(id, receipt);
    if (receipts.size > RECEIPTS_PER_SCOPE) receipts.delete(receipts.keys().next().value!);
    const held = receipts;
    // A refused submission did not happen, so its retry runs again.
    receipt.catch(() => { if (held.get(id) === receipt) held.delete(id); });
    try {
      void submit().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return receipt;
  }
}
