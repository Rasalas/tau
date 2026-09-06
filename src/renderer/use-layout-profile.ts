import { useEffect, useState } from "react";
import { layoutProfileFor, type ClientProfile } from "../workbench/client-profile";

/**
 * How wide the client is right now, as a profile. The claim a contribution
 * made stays what it was — the registry keeps whatever it registered — but
 * anything narrower than `COMPACT_WIDTH_PX` lays itself out compactly, which
 * is one attribute on `body` and a handful of conditions in the workbench.
 */
export function useLayoutProfile(profile: ClientProfile): ClientProfile {
  const [layout, setLayout] = useState(() => layoutProfileFor(profile, window.innerWidth));
  useEffect(() => {
    const update = () => setLayout(layoutProfileFor(profile, window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [profile]);
  useEffect(() => {
    document.body.dataset.profile = layout;
    document.body.dataset.client = profile;
  }, [layout, profile]);
  return layout;
}
