import { join } from "node:path";

const BASELINE_REPORT_NAMES = [
  "renderer-transcript-baseline-run-01.json",
  "renderer-transcript-baseline-run-02.json",
  "renderer-transcript-baseline-run-03.json",
];
const CURRENT_REPORT_NAMES = [
  "renderer-transcript-current-run-01.json",
  "renderer-transcript-current-run-02.json",
  "renderer-transcript-current-run-03.json",
];

function shellQuote(value) {
  if (/^\$[A-Z_][A-Z0-9_]*(?:\/|$)/u.test(value)) return `"${value}"`;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function reportPaths(root, names) {
  return names.map((name) => join(root, "reports", name));
}

function repeatedFlags(flag, values) {
  return values.map((value) => `${flag} ${shellQuote(value)}`).join(" \\\n  ");
}

/**
 * Produce a copy/pasteable, explicit-root renderer comparison recipe.
 *
 * The baseline is always made as a detached worktree of the subject checkout.
 * Reports stay in the worktree that produced them so the aggregate command can
 * consume the exact six files without relying on the caller's current cwd.
 */
export function buildRendererComparisonReproduction({
  currentRoot,
  baselineCommit,
  currentCommit,
  baselinePatch = join(currentRoot, "reports", "renderer-transcript-legacy-baseline.patch"),
  output = join(currentRoot, "reports", "renderer-transcript-comparison-aggregate.json"),
} = {}) {
  if (!currentRoot || !baselineCommit || !currentCommit) {
    throw new Error("currentRoot, baselineCommit, and currentCommit are required");
  }

  const currentReports = reportPaths(currentRoot, CURRENT_REPORT_NAMES);
  const baselineReports = BASELINE_REPORT_NAMES.map((name) => `$BASELINE_ROOT/reports/${name}`);
  const currentReportReferences = CURRENT_REPORT_NAMES.map((name) => `$CURRENT_ROOT/reports/${name}`);
  const currentRootLiteral = shellQuote(currentRoot);
  const baselineCommitLiteral = shellQuote(baselineCommit);
  const currentCommitLiteral = shellQuote(currentCommit);
  const patchLiteral = shellQuote(baselinePatch);
  const outputLiteral = shellQuote(output);
  const baselineReportArguments = repeatedFlags("--baseline", baselineReports);
  const currentReportArguments = repeatedFlags("--current", currentReportReferences);
  const aggregationCommand = [
    `node "$CURRENT_ROOT/scripts/renderer-comparison-aggregate.mjs" \\\n  ${baselineReportArguments} \\\n  ${currentReportArguments} \\\n  --baseline-root "$BASELINE_ROOT" \\\n  --current-root "$CURRENT_ROOT" \\\n  --baseline-commit "$BASELINE_COMMIT" \\\n  --current-commit "$CURRENT_COMMIT" \\\n  --baseline-patch "$BASELINE_PATCH" \\\n  --output ${outputLiteral}`,
  ].join("");

  const shell = [
    "set -euo pipefail",
    `CURRENT_ROOT=${currentRootLiteral}`,
    `BASELINE_COMMIT=${baselineCommitLiteral}`,
    `CURRENT_COMMIT=${currentCommitLiteral}`,
    `BASELINE_PATCH=${patchLiteral}`,
    'BASELINE_ROOT="$(mktemp -d -t tau-transcript-baseline.XXXXXX)"',
    'trap \'git -C "$CURRENT_ROOT" worktree remove --force "$BASELINE_ROOT" >/dev/null 2>&1 || true\' EXIT',
    'git -C "$CURRENT_ROOT" worktree add --detach "$BASELINE_ROOT" "$BASELINE_COMMIT"',
    'if [ -d "$CURRENT_ROOT/node_modules" ]; then ln -s "$CURRENT_ROOT/node_modules" "$BASELINE_ROOT/node_modules"; else npm --prefix "$BASELINE_ROOT" install; fi',
    'git -C "$BASELINE_ROOT" apply "$BASELINE_PATCH"',
    'npm --prefix "$BASELINE_ROOT" run build',
    'npm --prefix "$BASELINE_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-baseline-run-01.json',
    'npm --prefix "$BASELINE_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-baseline-run-02.json',
    'npm --prefix "$BASELINE_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-baseline-run-03.json',
    'npm --prefix "$CURRENT_ROOT" run build',
    'npm --prefix "$CURRENT_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-current-run-01.json',
    'npm --prefix "$CURRENT_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-current-run-02.json',
    'npm --prefix "$CURRENT_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-current-run-03.json',
    aggregationCommand,
  ].join("\n");

  return {
    subject: { currentRoot, baselineCommit, currentCommit },
    harness: { baselinePatch },
    baseline: {
      worktreeVariable: "$BASELINE_ROOT",
      reports: baselineReports,
      commands: [
        'BASELINE_ROOT="$(mktemp -d -t tau-transcript-baseline.XXXXXX)"',
        'git -C "$CURRENT_ROOT" worktree add --detach "$BASELINE_ROOT" "$BASELINE_COMMIT"',
        'git -C "$BASELINE_ROOT" apply "$BASELINE_PATCH"',
        'npm --prefix "$BASELINE_ROOT" run build',
        ...baselineReports.map((report) => `npm --prefix "$BASELINE_ROOT" run benchmark:renderer -- --no-build ${report.replace("$BASELINE_ROOT/", "")}`),
      ],
    },
    current: {
      root: currentRoot,
      reports: currentReports,
      commands: [
        'npm --prefix "$CURRENT_ROOT" run build',
        ...CURRENT_REPORT_NAMES.map((name) => `npm --prefix "$CURRENT_ROOT" run benchmark:renderer -- --no-build reports/${name}`),
      ],
    },
    aggregation: {
      command: aggregationCommand,
      baselineReports,
      currentReports,
      baselineRoot: "$BASELINE_ROOT",
      currentRoot: "$CURRENT_ROOT",
      baselineCommit: "$BASELINE_COMMIT",
      currentCommit: "$CURRENT_COMMIT",
      baselinePatch: "$BASELINE_PATCH",
      output,
    },
    shell,
  };
}

export { BASELINE_REPORT_NAMES, CURRENT_REPORT_NAMES };
