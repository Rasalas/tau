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
 * The subject checkout is never used as the measured current worktree. Both
 * sides are detached at their recorded commits, and reports are copied back to
 * the subject checkout before aggregation so the six raw inputs survive the
 * temporary worktree cleanup.
 */
export function buildRendererComparisonReproduction({
  currentRoot,
  subjectRoot = currentRoot,
  baselineCommit,
  currentCommit,
  baselinePatch = join(subjectRoot, "reports", "renderer-transcript-legacy-baseline.patch"),
  output = join(subjectRoot, "reports", "renderer-transcript-comparison-aggregate.json"),
} = {}) {
  if (!currentRoot || !subjectRoot || !baselineCommit || !currentCommit) {
    throw new Error("currentRoot, subjectRoot, baselineCommit, and currentCommit are required");
  }

  const baselineReports = reportPaths(subjectRoot, BASELINE_REPORT_NAMES);
  const currentReports = reportPaths(subjectRoot, CURRENT_REPORT_NAMES);
  const baselineReportReferences = BASELINE_REPORT_NAMES.map((name) => `$SUBJECT_ROOT/reports/${name}`);
  const currentReportReferences = CURRENT_REPORT_NAMES.map((name) => `$SUBJECT_ROOT/reports/${name}`);
  const subjectRootLiteral = shellQuote(subjectRoot);
  const baselineCommitLiteral = shellQuote(baselineCommit);
  const currentCommitLiteral = shellQuote(currentCommit);
  const patchLiteral = shellQuote(baselinePatch);
  const defaultOutput = join(subjectRoot, "reports", "renderer-transcript-comparison-aggregate.json");
  const outputReference = output === defaultOutput ? "$SUBJECT_ROOT/reports/renderer-transcript-comparison-aggregate.json" : output;
  const outputArgument = shellQuote(outputReference);
  const baselineReportArguments = repeatedFlags("--baseline", baselineReportReferences);
  const currentReportArguments = repeatedFlags("--current", currentReportReferences);
  const aggregationCommand = [
    `node "$SUBJECT_ROOT/scripts/renderer-comparison-aggregate.mjs" \\\n  ${baselineReportArguments} \\\n  ${currentReportArguments} \\\n  --baseline-root "$BASELINE_ROOT" \\\n  --current-root "$CURRENT_ROOT" \\\n  --baseline-commit "$BASELINE_COMMIT" \\\n  --current-commit "$CURRENT_COMMIT" \\\n  --baseline-patch "$BASELINE_PATCH" \\\n  --output ${outputArgument} --subject-root "$SUBJECT_ROOT"`,
  ].join("");

  const shell = [
    "set -euo pipefail",
    `SUBJECT_ROOT=${subjectRootLiteral}`,
    `BASELINE_COMMIT=${baselineCommitLiteral}`,
    `CURRENT_COMMIT=${currentCommitLiteral}`,
    `BASELINE_PATCH=${patchLiteral}`,
    'BASELINE_ROOT="$(mktemp -d -t tau-transcript-baseline.XXXXXX)"',
    'CURRENT_ROOT="$(mktemp -d -t tau-transcript-current.XXXXXX)"',
    "cleanup() {",
    '  if [ -e "$BASELINE_ROOT/.git" ]; then git -C "$SUBJECT_ROOT" worktree remove --force "$BASELINE_ROOT" >/dev/null 2>&1 || true; else rmdir "$BASELINE_ROOT" >/dev/null 2>&1 || true; fi',
    '  if [ -e "$CURRENT_ROOT/.git" ]; then git -C "$SUBJECT_ROOT" worktree remove --force "$CURRENT_ROOT" >/dev/null 2>&1 || true; else rmdir "$CURRENT_ROOT" >/dev/null 2>&1 || true; fi',
    "}",
    "trap cleanup EXIT",
    'git -C "$SUBJECT_ROOT" worktree add --detach "$BASELINE_ROOT" "$BASELINE_COMMIT"',
    'git -C "$SUBJECT_ROOT" worktree add --detach "$CURRENT_ROOT" "$CURRENT_COMMIT"',
    'if [ -d "$SUBJECT_ROOT/node_modules" ]; then ln -s "$SUBJECT_ROOT/node_modules" "$BASELINE_ROOT/node_modules"; ln -s "$SUBJECT_ROOT/node_modules" "$CURRENT_ROOT/node_modules"; else npm --prefix "$BASELINE_ROOT" install; npm --prefix "$CURRENT_ROOT" install; fi',
    'git -C "$BASELINE_ROOT" apply "$BASELINE_PATCH"',
    'npm --prefix "$BASELINE_ROOT" run build',
    'npm --prefix "$BASELINE_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-baseline-run-01.json',
    'cp "$BASELINE_ROOT/reports/renderer-transcript-baseline-run-01.json" "$SUBJECT_ROOT/reports/renderer-transcript-baseline-run-01.json"',
    'npm --prefix "$BASELINE_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-baseline-run-02.json',
    'cp "$BASELINE_ROOT/reports/renderer-transcript-baseline-run-02.json" "$SUBJECT_ROOT/reports/renderer-transcript-baseline-run-02.json"',
    'npm --prefix "$BASELINE_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-baseline-run-03.json',
    'cp "$BASELINE_ROOT/reports/renderer-transcript-baseline-run-03.json" "$SUBJECT_ROOT/reports/renderer-transcript-baseline-run-03.json"',
    'npm --prefix "$CURRENT_ROOT" run build',
    'npm --prefix "$CURRENT_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-current-run-01.json',
    'cp "$CURRENT_ROOT/reports/renderer-transcript-current-run-01.json" "$SUBJECT_ROOT/reports/renderer-transcript-current-run-01.json"',
    'npm --prefix "$CURRENT_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-current-run-02.json',
    'cp "$CURRENT_ROOT/reports/renderer-transcript-current-run-02.json" "$SUBJECT_ROOT/reports/renderer-transcript-current-run-02.json"',
    'npm --prefix "$CURRENT_ROOT" run benchmark:renderer -- --no-build reports/renderer-transcript-current-run-03.json',
    'cp "$CURRENT_ROOT/reports/renderer-transcript-current-run-03.json" "$SUBJECT_ROOT/reports/renderer-transcript-current-run-03.json"',
    aggregationCommand,
  ].join("\n");

  return {
    subject: { currentRoot: subjectRoot, measuredCurrentRoot: currentRoot, baselineCommit, currentCommit },
    harness: { baselinePatch },
    baseline: {
      worktreeVariable: "$BASELINE_ROOT",
      reports: baselineReports,
      commands: [
        'BASELINE_ROOT="$(mktemp -d -t tau-transcript-baseline.XXXXXX)"',
        'git -C "$SUBJECT_ROOT" worktree add --detach "$BASELINE_ROOT" "$BASELINE_COMMIT"',
        'git -C "$BASELINE_ROOT" apply "$BASELINE_PATCH"',
        'npm --prefix "$BASELINE_ROOT" run build',
        ...BASELINE_REPORT_NAMES.map((name) => `npm --prefix "$BASELINE_ROOT" run benchmark:renderer -- --no-build reports/${name}`),
      ],
    },
    current: {
      worktreeVariable: "$CURRENT_ROOT",
      subjectRoot,
      measuredRoot: currentRoot,
      reports: currentReports,
      commands: [
        'CURRENT_ROOT="$(mktemp -d -t tau-transcript-current.XXXXXX)"',
        'git -C "$SUBJECT_ROOT" worktree add --detach "$CURRENT_ROOT" "$CURRENT_COMMIT"',
        'npm --prefix "$CURRENT_ROOT" run build',
        ...CURRENT_REPORT_NAMES.map((name) => `npm --prefix "$CURRENT_ROOT" run benchmark:renderer -- --no-build reports/${name}`),
      ],
    },
    aggregation: {
      command: aggregationCommand,
      baselineReports: baselineReportReferences,
      currentReports: currentReportReferences,
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
