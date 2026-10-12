import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("handles failures of every fire-and-forget thread persistence call", () => {
  const offenders: string[] = [];
  for (const directory of readdirSync("kits")) {
    const path = join("kits", directory, "thread-backend.ts");
    if (!existsSync(path)) continue;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isVoidExpression(node)) {
        let persists = false;
        let catches = false;
        const inspect = (expression: ts.Node) => {
          if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
            const name = expression.expression.name.text;
            if (/^persist/u.test(name) || name === "commit") persists = true;
            if (name === "catch" && expression.arguments.length > 0) catches = true;
            inspect(expression.expression.expression);
          } else if (ts.isParenthesizedExpression(expression)) inspect(expression.expression);
        };
        inspect(node.expression);
        if (persists && !catches) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          offenders.push(`${path}:${line + 1}: ${node.getText(source)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(offenders).toEqual([]);
});
