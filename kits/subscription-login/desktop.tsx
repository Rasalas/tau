import type { DesktopExtension } from "tau";
import { SubscriptionLoginIndicator } from "./indicator.js";
import { hasAcknowledged, SUBSCRIPTION_LOGIN_NOTE, warnsAbout } from "./policy.js";
import { SUBSCRIPTION_LOGIN_EXTENSION_ID } from "./protocol.js";
import { SubscriptionLoginPrompt } from "./prompt.js";

const EVERY_CLIENT = ["desktop", "web", "compact"] as const;

/**
 * Says where a vendor forbids the subscription login Pi performs: a shield at
 * the thread title, a badge in the model picker, and one question per
 * provider before such a model is first chosen or sent to. Switching the kit
 * off removes all three; the model itself stays usable either way.
 */
export const subscriptionLoginExtension: DesktopExtension = {
  id: SUBSCRIPTION_LOGIN_EXTENSION_ID,
  name: "Subscription Login Warning",
  activate(plugin) {
    plugin.registerRegion({ id: "subscription-login.indicator", placement: "thread-title", profiles: EVERY_CLIENT, Component: SubscriptionLoginIndicator });
    plugin.registerModelBadge({
      id: "subscription-login.badge",
      profiles: EVERY_CLIENT,
      applies: (model) => warnsAbout(model),
      label: "vendor apps only",
      title: "The vendor allows this subscription login only in its own apps.",
      tone: "warning",
      note: SUBSCRIPTION_LOGIN_NOTE,
    });
    plugin.registerComposerGate({
      id: "subscription-login.ask",
      profiles: EVERY_CLIENT,
      check: ({ model }) => warnsAbout(model) && !hasAcknowledged(plugin.preferences, model.provider),
      Component: SubscriptionLoginPrompt,
    });
  },
};

export default subscriptionLoginExtension;
