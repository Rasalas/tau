/**
 * `when` clauses on keybindings: identifiers joined by `!`, `&&`, `||` and
 * parentheses, as in VS Code and T3 Code ("terminalFocus && !stageFocus").
 * `true` and `false` are constants; every other identifier is a context the
 * window answers when a key goes down (see `keybinding-context.ts`).
 */
export type WhenNode =
  | { type: "name"; name: string }
  | { type: "not"; node: WhenNode }
  | { type: "and" | "or"; left: WhenNode; right: WhenNode };

const MAX_DEPTH = 32;

function tokenize(source: string): string[] | undefined {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const space = /^\s+/u.exec(rest);
    if (space) { index += space[0].length; continue; }
    const operator = /^(&&|\|\||!|\(|\))/u.exec(rest) ?? /^[A-Za-z_][\w.-]*/u.exec(rest);
    if (!operator) return undefined;
    tokens.push(operator[0]);
    index += operator[0].length;
  }
  return tokens;
}

/** The parsed clause, or undefined when it is not one. */
export function parseWhen(source: string): WhenNode | undefined {
  const tokens = tokenize(source);
  if (!tokens?.length) return undefined;
  let at = 0;
  const operand = (depth: number): WhenNode | undefined => {
    if (depth > MAX_DEPTH) return undefined;
    const token = tokens[at++];
    if (token === "!") {
      const node = operand(depth + 1);
      return node && { type: "not", node };
    }
    if (token === "(") {
      const node = either(depth + 1);
      return node && tokens[at++] === ")" ? node : undefined;
    }
    return token && /^[A-Za-z_]/u.test(token) ? { type: "name", name: token } : undefined;
  };
  const chain = (depth: number, op: "&&" | "||", next: (depth: number) => WhenNode | undefined): WhenNode | undefined => {
    let left = next(depth);
    while (left && tokens[at] === op) {
      at += 1;
      const right = next(depth);
      left = right && { type: op === "&&" ? "and" : "or", left, right };
    }
    return left;
  };
  const both = (depth: number) => chain(depth, "&&", operand);
  const either = (depth: number) => chain(depth, "||", both);
  const tree = either(0);
  return tree && at === tokens.length ? tree : undefined;
}

export function evaluateWhen(node: WhenNode, context: (name: string) => boolean): boolean {
  switch (node.type) {
    case "name": return node.name === "true" || (node.name !== "false" && context(node.name));
    case "not": return !evaluateWhen(node.node, context);
    case "and": return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or": return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

function names(node: WhenNode, into = new Set<string>()): Set<string> {
  if (node.type === "name") { if (node.name !== "true" && node.name !== "false") into.add(node.name); }
  else if (node.type === "not") names(node.node, into);
  else { names(node.left, into); names(node.right, into); }
  return into;
}

/**
 * A clause that needs some context to hold: false where nothing is focused or
 * open. Such a binding wins over one without that need, and runs before the
 * focused element sees the key.
 */
export function isSpecificWhen(node: WhenNode | undefined): boolean {
  return node !== undefined && !evaluateWhen(node, () => false);
}

/** Whether both clauses can hold at once; a missing clause always holds. */
export function whenOverlaps(a: WhenNode | undefined, b: WhenNode | undefined): boolean {
  if (!a || !b) return true;
  const all = [...names(b, names(a))];
  // Past a dozen names the check stops being cheap; calling it an overlap is the safe answer.
  if (all.length > 12) return true;
  for (let mask = 0; mask < 1 << all.length; mask += 1) {
    const context = (name: string) => (mask & (1 << all.indexOf(name))) !== 0;
    if (evaluateWhen(a, context) && evaluateWhen(b, context)) return true;
  }
  return false;
}
