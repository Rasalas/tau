/// <reference types="vite/client" />

import type { TauDesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    tau?: TauDesktopApi;
  }
}
