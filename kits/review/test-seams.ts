/** The host seams the kit's thread links register with, as no-ops for a test that does not look at them. */
export const LINK_SEAMS = {
  registerRuntimeExtension: () => () => undefined,
  registerThreadLifecycle: () => () => undefined,
  thread: () => undefined,
};
