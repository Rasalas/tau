/** A kit opts into home-machine routing; workspace identities remain opaque. */
export interface HostMachineRoutingContext {
  activeMachine(): string | undefined;
  call(machine: string, command: string, input?: unknown): Promise<unknown>;
  emit(name: string, payload: unknown, topic: string): void;
  refresh(): void;
  watching(topic: string): boolean;
  connected(machine: string): boolean;
}
export interface HostMachineRoutingAdapter {
  /** undefined uses workspace/thread routing; null keeps the call local. */
  route?(input: unknown): string | null | undefined;
  remoteResult?(machine: string, command: string, input: unknown, result: unknown, local?: () => Promise<unknown>, revision?: unknown): unknown | Promise<unknown>;
  beforeCall?(machine: string): unknown;
  localResult?(command: string, result: unknown): unknown;
  localEvent?(name: string, payload: unknown): unknown;
  remoteEvent?(machine: string, name: string, payload: unknown): unknown;
  owners?(topic: string): readonly string[];
  reconnect?(machine: string): void;
  dispose?(): void;
}
export interface HostMachineRoutingPolicy {
  /** Device/window operations that must stay on the connected host. */
  localCommands?: readonly string[];
  create?(context: HostMachineRoutingContext): HostMachineRoutingAdapter;
}
export interface HostMachineRoutingContribution {
  readonly policy: HostMachineRoutingPolicy;
  onDispose(listener: () => void): () => void;
}
