import { errorMessage } from "../workbench/error-message";
import { throwFailures } from "./extension-lifecycle-errors";

type Dispose = () => void;

interface Provider {
  extensionId: string;
  value: unknown;
}

interface Binding {
  provider: Provider;
  dispose?: Dispose;
}

interface ServiceUser {
  extensionId: string;
  use(value: unknown): Dispose | void;
  binding?: Binding;
}

function failure(extensionId: string, id: string, action: string, cause: unknown): Error {
  return new Error(`Extension ${extensionId} ${action} service ${id}: ${errorMessage(cause)}`, { cause });
}

/**
 * Owns service bindings independently of extension activation order. A failed
 * publication rolls back every binding, and a failed subscription removes itself.
 * Callbacks and cleanup fail synchronously, after the other consumers have run.
 */
export class ExtensionServiceRegistry {
  readonly #providers = new Map<string, Provider>();
  readonly #users = new Map<string, Set<ServiceUser>>();

  provide<T>(extensionId: string, id: string, value: T): Dispose {
    const held = this.#providers.get(id);
    if (held) throw new Error(`Extension service ${id} is already provided by ${held.extensionId}`);
    const provider = { extensionId, value };
    this.#providers.set(id, provider);
    const errors = this.#visit(id, (user) => {
      // A previous callback can unsubscribe another consumer or withdraw the offer.
      if (this.#users.get(id)?.has(user) && this.#providers.get(id) === provider) this.#bind(id, user, provider);
    });
    if (errors.length > 0) {
      try { this.#withdraw(id, provider); } catch (error) { errors.push(error); }
      throwFailures(errors);
    }
    return () => this.#withdraw(id, provider);
  }

  use<T>(extensionId: string, id: string, use: (value: T) => Dispose | void): Dispose {
    const user: ServiceUser = { extensionId, use: use as ServiceUser["use"] };
    const users = this.#users.get(id) ?? new Set<ServiceUser>();
    this.#users.set(id, users);
    users.add(user);
    const dispose = () => {
      if (!users.delete(user)) return;
      if (users.size === 0) this.#users.delete(id);
      this.#release(id, user);
    };
    const held = this.#providers.get(id);
    if (held) {
      try { this.#bind(id, user, held); } catch (error) {
        dispose();
        throw error;
      }
    }
    return dispose;
  }

  ids(): string[] {
    return [...this.#providers.keys()];
  }

  #bind(id: string, user: ServiceUser, provider: Provider): void {
    this.#release(id, user);
    const binding: Binding = { provider };
    user.binding = binding;
    try {
      const dispose = user.use(provider.value) ?? undefined;
      if (user.binding === binding) binding.dispose = dispose;
      // The callback may have withdrawn the provider or removed its subscription.
      else dispose?.();
    } catch (error) {
      if (user.binding === binding) user.binding = undefined;
      throw failure(user.extensionId, id, "using", error);
    }
  }

  #release(id: string, user: ServiceUser): void {
    const binding = user.binding;
    user.binding = undefined;
    try { binding?.dispose?.(); } catch (error) {
      throw failure(user.extensionId, id, "releasing", error);
    }
  }

  #withdraw(id: string, provider: Provider): void {
    // Compare the registration itself: a stale disposer must not remove a newer
    // offer, even if the same extension published both.
    if (this.#providers.get(id) !== provider) return;
    this.#providers.delete(id);
    throwFailures(this.#visit(id, (user) => {
      if (user.binding?.provider === provider) this.#release(id, user);
    }));
  }

  #visit(id: string, apply: (user: ServiceUser) => void): unknown[] {
    const errors: unknown[] = [];
    for (const user of [...(this.#users.get(id) ?? [])]) {
      try { apply(user); } catch (error) { errors.push(error); }
    }
    return errors;
  }
}
