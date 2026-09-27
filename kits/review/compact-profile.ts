import { useEffect, useState } from "react";

/** Whether the window draws the compact layout (a phone, a tablet); a desktop window can switch to it as it narrows. */
export function useCompactProfile(): boolean {
  const read = () => typeof document !== "undefined" && document.body.dataset.profile === "compact";
  const [compact, setCompact] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setCompact(read()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-profile"] });
    return () => observer.disconnect();
  }, []);
  return compact;
}
