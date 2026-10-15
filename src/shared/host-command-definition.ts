import type { HostCommandMetadata } from "./host-command-metadata.js";

/** The protocol declaration owns decoding, result types and dispatch metadata. */
export interface HostCommandAudit {
  label: string;
  thread?: number;
  automatic?: true;
  quiet?: true;
}
export interface HostCommandDeclaration<Args extends readonly unknown[], Result, WireArgs extends readonly unknown[] | never = never> {
  decode(params: readonly unknown[]): Args;
  audit?: HostCommandAudit;
  /** Type witness only; no result value is stored in a declaration. */
  readonly resultType?: Result;
  readonly wireType?: WireArgs;
}
export interface HostCommand<Args extends readonly unknown[], Result, WireArgs extends readonly unknown[] | never = never>
  extends HostCommandDeclaration<Args, Result, WireArgs>, HostCommandMetadata {}

type AnyDeclaration = HostCommandDeclaration<readonly unknown[], unknown, readonly unknown[] | never>;
type AttachedCommand<Declaration> = Declaration extends HostCommandDeclaration<infer Args, infer Result, infer WireArgs>
  ? HostCommand<Args, Result, WireArgs>
  : never;
type AttachedCommands<Declarations> = { [Name in keyof Declarations]: AttachedCommand<Declarations[Name]> };

/** Every policy entry needs a declaration, and every declaration needs policy. */
export function attachCommandMetadata<
  const Metadata extends Readonly<Record<string, HostCommandMetadata>>,
  const Declarations extends { [Name in keyof Metadata]: AnyDeclaration },
>(
  metadata: Metadata,
  declarations: Declarations & Record<Exclude<keyof Declarations, keyof Metadata>, never>,
): AttachedCommands<Declarations> {
  return Object.fromEntries(Object.entries(declarations).map(([name, declaration]) => [
    name, { ...declaration, ...metadata[name] },
  ])) as AttachedCommands<Declarations>;
}

export function command<Result, WireArgs extends readonly unknown[] | never = never>() {
  return <const Args extends readonly unknown[]>(definition: HostCommandDeclaration<Args, Result, WireArgs>): HostCommandDeclaration<Args, Result, WireArgs> => definition;
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
