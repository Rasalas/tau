import { useRef, useState } from "react";
import { ArrowUpRight, Quote } from "lucide-react";
import { Popover, useWorkbenchShell, type MessageBlockProps } from "tau";

/** An excerpt block of a sent prompt: where it came from, the quote and what the user said about it. */
export interface SentExcerpt {
  source: string;
  quote: string;
  comment?: string;
}

const COMMENT_PREFIX = "My comment on this excerpt: ";
const LABEL_LENGTH = 48;

/** The reverse of `serializeChips` for one excerpt; a body that is not in its shape is all quote. */
export function parseExcerpt(body: string): SentExcerpt {
  const lines = body.split("\n");
  const from = /^From (.*):$/u.exec(lines[0] ?? "");
  const quoted: string[] = [];
  let at = from ? 1 : 0;
  for (; at < lines.length && lines[at]!.startsWith(">"); at += 1) quoted.push(lines[at]!.replace(/^> ?/u, ""));
  if (quoted.length === 0 && !from) return { source: "", quote: body.trim() };
  const rest = lines.slice(at).join("\n").trim();
  const comment = (rest.startsWith(COMMENT_PREFIX) ? rest.slice(COMMENT_PREFIX.length) : rest).replace(/^(\s*)<\\\/excerpt>/gmu, "$1</excerpt>");
  return { source: from?.[1] ?? "", quote: quoted.join("\n"), ...(comment ? { comment } : {}) };
}

/** What the chip reads: the user's own words when there are some, else the start of the quote. */
export function excerptLabel({ quote, comment }: SentExcerpt): string {
  const flat = (comment ?? quote).replace(/\s+/gu, " ").trim();
  const cut = flat.length > LABEL_LENGTH ? `${flat.slice(0, LABEL_LENGTH)}…` : flat;
  return comment ? cut : `“${cut}”`;
}

/** The block a sent excerpt becomes in the transcript: a chip whose popover holds the quote and, when the quote came from a reply of this thread, a way back to it. */
export function SentExcerptChip({ body, attributes }: MessageBlockProps) {
  const excerpt = parseExcerpt(body);
  const actions = useWorkbenchShell()?.actions;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const label = excerptLabel(excerpt);
  const sourceId = attributes.message;
  const reveal = sourceId ? actions?.revealMessage : undefined;

  const goToSource = async () => {
    setOpen(false);
    if (!sourceId || !reveal) return;
    if (!(await reveal(sourceId))) actions?.notify("The quoted message is no longer in this thread.");
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="sent-excerpt-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Quoted text: ${label}`}
        data-excerpt-chip=""
        onClick={() => setOpen((value) => !value)}
      >
        <Quote size={12} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {open ? (
        <Popover anchor={anchor} side="bottom" align="end" label="Quoted text" className="sent-excerpt-popover" onClose={() => setOpen(false)}>
          {excerpt.source ? <small>{excerpt.source}</small> : null}
          <blockquote>{excerpt.quote}</blockquote>
          {excerpt.comment ? <p>{excerpt.comment}</p> : null}
          {reveal ? (
            <button type="button" className="sent-excerpt-source" onClick={() => void goToSource()}>
              <ArrowUpRight size={13} aria-hidden="true" />
              Go to source
            </button>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}
