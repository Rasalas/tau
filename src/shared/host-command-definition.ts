/** The protocol declaration owns decoding, result types and dispatch metadata. */
export interface HostCommandAudit {
  label: string;
  thread?: number;
  automatic?: true;
  quiet?: true;
}
export interface HostCommand<Args extends readonly unknown[], Result, WireArgs extends readonly unknown[] | never = never> {
  decode(params: readonly unknown[]): Args;
  access: "read" | "write" | "owner";
  job?: true;
  audit?: HostCommandAudit;
  /** Type witness only; no result value is stored in a declaration. */
  readonly resultType?: Result;
  readonly wireType?: WireArgs;
}
export function command<Result, WireArgs extends readonly unknown[] | never = never>() {
  return <const Args extends readonly unknown[]>(definition: HostCommand<Args, Result, WireArgs>): HostCommand<Args, Result, WireArgs> => definition;
}
export type HostCommandDecoded<C> = C extends HostCommand<infer Args, unknown, readonly unknown[] | never> ? Args : never;
type OptionalTail<Args extends readonly unknown[]> = Args extends readonly [...infer Before, infer Last]
  ? undefined extends Last ? [...OptionalTail<Before>, Last?] : [...Args]
  : [];
/** Optional wire fields can be omitted, as older clients already do. */
export type HostCommandArgs<C> = C extends HostCommand<readonly unknown[], unknown, infer WireArgs>
  ? [WireArgs] extends [never] ? OptionalTail<HostCommandDecoded<C>> : WireArgs
  : never;
export type HostCommandResult<C> = C extends HostCommand<readonly unknown[], infer Result, readonly unknown[] | never> ? Result : never;
export type HostCommandClient<C> = (...args: HostCommandArgs<C>) => Promise<HostCommandResult<C>>;
