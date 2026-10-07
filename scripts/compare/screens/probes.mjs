// The elements both apps have, named once. A screen adds its own probes on top.
// A spec is a CSS selector, or `selector@regex` for the first match whose text matches.

export const CHROME = {
  tau: {
    header: "header.title-bar",
    sidebar: "aside.session-rail",
    search: "button.rail-search",
    composer: ".composer-surface",
    composerInput: "textarea",
    sendButton: "button.send-button:not(.stop)",
  },
  reference: {
    header: "main[data-slot=sidebar-inset] header",
    sidebar: "[data-slot=sidebar-inner]",
    search: "input[aria-label='Search threads']",
    composer: "[data-slot=composer-shell]",
    composerInput: "[data-testid=composer-editor]",
    sendButton: "[data-slot=composer-shell] button[type=submit], [data-slot=composer-shell] button[aria-label='Send message']",
  },
};

export const RAIL = {
  tau: {
    rowActive: "article.thread-row.active",
    row: "article.thread-row:not(.active)",
    rowTitle: "article.thread-row .thread-title",
    rowMeta: "article.thread-row .thread-project-line",
    rowStatus: ".thread-status-age",
    sectionLabel: ".thread-group-label, .settled-shelf-toggle",
    settledRow: "[data-rail-section=settled] article.thread-row",
  },
  reference: {
    rowActive: "[data-testid=sidebar-row-card][data-active=true], [data-testid=sidebar-row-card][aria-current]",
    row: "[data-testid=sidebar-row-card]",
    rowTitle: "[data-testid=sidebar-row-card] [aria-label='Thread title'], [data-testid=sidebar-row-card] .truncate",
    rowMeta: "[data-testid=sidebar-row-card] .tabular-nums",
    rowStatus: "[data-testid=sidebar-row-card] [data-status], [data-testid=sidebar-row-card] .tabular-nums",
    sectionLabel: "[data-testid=sidebar-settled-shelf-toggle], [data-testid=sidebar-pinned-header]",
    settledRow: "[data-testid=sidebar-row-slim]",
  },
};

export const TRANSCRIPT = {
  tau: {
    threadHeader: ".conversation-header, .thread-header",
    userBubble: "article.message.user .message-text",
    prose: "article.message:not(.user) .markdown p",
    workRow: ".inline-transcript-activity",
    liveRow: "#thread-transcript [class*=working], .transcript-current-row",
    codeBlock: ".md-code",
    codeHead: ".md-code-head",
    table: ".markdown table",
    tableHead: ".markdown table th",
    inlineCode: ".markdown p code",
  },
  reference: {
    threadHeader: "main[data-slot=sidebar-inset] header",
    userBubble: ".bg-message",
    prose: ".chat-markdown p",
    workRow: "button@^(Worked for|Ran \\d+ commands?|Thought)",
    liveRow: "div@^Working for",
    codeBlock: ".chat-markdown-codeblock",
    codeHead: ".chat-markdown-codeblock > div",
    table: ".chat-markdown table",
    tableHead: ".chat-markdown table th",
    inlineCode: ".chat-markdown p code, .chat-markdown p [class*=chip]",
  },
};

/** Chrome plus extra probes, per app. */
export function probes(...sets) {
  const out = { tau: {}, reference: {} };
  for (const set of sets) for (const id of ["tau", "reference"]) Object.assign(out[id], set[id] ?? {});
  return out;
}
