/* tslint:disable */
/* eslint-disable */

export class BrowserTunnel {
    free(): void;
    [Symbol.dispose](): void;
    close(): void;
    close_code(): number;
    close_reason(): string;
    closed(): boolean;
    drain(): Uint8Array;
    feed(bytes: Uint8Array): void;
    flush(): void;
    constructor(url: string, host: string, pin: string, key: boolean);
    poll(): boolean;
    receive(): string | undefined;
    send(text: string): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_browsertunnel_free: (a: number, b: number) => void;
    readonly browsertunnel_close: (a: number) => void;
    readonly browsertunnel_close_code: (a: number) => number;
    readonly browsertunnel_close_reason: (a: number, b: number) => void;
    readonly browsertunnel_closed: (a: number) => number;
    readonly browsertunnel_drain: (a: number, b: number) => void;
    readonly browsertunnel_feed: (a: number, b: number, c: number, d: number) => void;
    readonly browsertunnel_flush: (a: number, b: number) => void;
    readonly browsertunnel_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly browsertunnel_poll: (a: number, b: number) => void;
    readonly browsertunnel_receive: (a: number, b: number) => void;
    readonly browsertunnel_send: (a: number, b: number, c: number, d: number) => void;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
