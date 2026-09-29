import type { DesktopExtension, RegionProps } from "tau";

const REQUEST = "Review the changes in this thread for bugs and missing tests.";

/** A button in the thread header that puts a review request into the composer. */
function ReviewButton({ snapshot, actions }: RegionProps) {
  if (!snapshot) return null;
  return (
    <button
      type="button"
      title="Ask the agent to review its changes"
      onClick={() => actions.focusComposer(REQUEST)}
      style={{
        font: "12px var(--sans)",
        color: "var(--ink-2)",
        background: "none",
        border: "1px solid var(--line-control)",
        borderRadius: 6,
        padding: "2px 8px",
        cursor: "pointer",
      }}
    >
      Review
    </button>
  );
}

const extension: DesktopExtension = {
  id: "example.review-button",
  name: "Review button",
  activate(context) {
    return context.registerRegion({
      id: "example.review-button",
      placement: "title-bar",
      Component: ReviewButton,
    });
  },
};

export default extension;
