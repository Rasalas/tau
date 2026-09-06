import type { DesktopExtension } from "../extension-system";

/**
 * Every kit Tau ships lives under `kits/` and is loaded from `dist-kits/` the
 * way an installed package is (ADR 0014). Nothing is registered here any more;
 * ticket 09 removes this module with the other transitional paths.
 */
export const bundledExtensions: DesktopExtension[] = [];
