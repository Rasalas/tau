import { findProjectForSession, type PreferencesStore, type UiProject, type UiSession } from "tau";
import { visibleThreads } from "./navigation.js";
import type { ProjectOrderService } from "./protocol.js";
import { orderProjects, readRailOrder } from "./rail-order.js";

/** The rail's project order for other kits (`PROJECT_ORDER_SERVICE`); it follows the rail's grouping and sort settings. */
export function projectOrderService(preferences: Pick<PreferencesStore, "value" | "optionValue" | "subscribe">): ProjectOrderService {
  return {
    order: <T extends UiProject>(projects: readonly T[], threads: readonly UiSession[]) =>
      orderProjects(projects, visibleThreads(threads, {}), readRailOrder(preferences), (session) => findProjectForSession(projects, session)),
    subscribe: (listener) => preferences.subscribe(listener),
  };
}
