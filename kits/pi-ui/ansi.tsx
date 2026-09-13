import type { ReactNode } from "react";

// Matches ANSI escape codes: SGR codes (ending with m) and others
// oxlint-disable-next-line eslint/no-control-regex
const ANSI_REGEX = /\u001b\[([0-9;]*)([A-Za-z])/gu;

interface AnsiStyleState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
  bgColor?: string;
}

const FG_COLORS: Record<number, string> = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

const BG_COLORS: Record<number, string> = {
  40: "ansi-bg-black",
  41: "ansi-bg-red",
  42: "ansi-bg-green",
  43: "ansi-bg-yellow",
  44: "ansi-bg-blue",
  45: "ansi-bg-magenta",
  46: "ansi-bg-cyan",
  47: "ansi-bg-white",
  100: "ansi-bg-bright-black",
  101: "ansi-bg-bright-red",
  102: "ansi-bg-bright-green",
  103: "ansi-bg-bright-yellow",
  104: "ansi-bg-bright-blue",
  105: "ansi-bg-bright-magenta",
  106: "ansi-bg-bright-cyan",
  107: "ansi-bg-bright-white",
};

function applySgrCodes(state: AnsiStyleState, codes: number[]): void {
  if (codes.length === 0) {
    state.bold = false;
    state.dim = false;
    state.italic = false;
    state.underline = false;
    state.color = undefined;
    state.bgColor = undefined;
    return;
  }

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) {
      state.bold = false;
      state.dim = false;
      state.italic = false;
      state.underline = false;
      state.color = undefined;
      state.bgColor = undefined;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 39) {
      state.color = undefined;
    } else if (code === 49) {
      state.bgColor = undefined;
    } else if (FG_COLORS[code]) {
      state.color = FG_COLORS[code];
    } else if (BG_COLORS[code]) {
      state.bgColor = BG_COLORS[code];
    }
  }
}

function stateToClassNames(state: AnsiStyleState): string | undefined {
  const classes: string[] = [];
  if (state.bold) classes.push("ansi-bold");
  if (state.dim) classes.push("ansi-dim");
  if (state.italic) classes.push("ansi-italic");
  if (state.underline) classes.push("ansi-underline");
  if (state.color) classes.push(state.color);
  if (state.bgColor) classes.push(state.bgColor);
  return classes.length > 0 ? classes.join(" ") : undefined;
}

/**
 * Parses ANSI SGR escape sequences and renders them as styled React elements
 * mapped to Tau's theme tokens.
 */
export function renderAnsi(text: string): ReactNode {
  if (!text || !text.includes("\u001b")) {
    return text;
  }

  const nodes: ReactNode[] = [];
  const state: AnsiStyleState = {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(ANSI_REGEX);

  while ((match = regex.exec(text)) !== null) {
    const textSegment = text.slice(lastIndex, match.index);
    if (textSegment) {
      const className = stateToClassNames(state);
      if (className) {
        nodes.push(
          <span className={className} key={nodes.length}>
            {textSegment}
          </span>
        );
      } else {
        nodes.push(textSegment);
      }
    }

    const command = match[2];
    if (command === "m") {
      const rawParams = match[1];
      const codes = rawParams
        ? rawParams.split(";").map((p) => (p ? Number.parseInt(p, 10) : 0))
        : [0];
      applySgrCodes(state, codes);
    }
    lastIndex = regex.lastIndex;
  }

  const remaining = text.slice(lastIndex);
  if (remaining) {
    const className = stateToClassNames(state);
    if (className) {
      nodes.push(
        <span className={className} key={nodes.length}>
          {remaining}
        </span>
      );
    } else {
      nodes.push(remaining);
    }
  }

  return nodes.length === 1 ? nodes[0] : <>{nodes}</>;
}
