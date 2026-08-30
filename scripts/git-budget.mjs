export function evaluateGitBudgets(workload, budgets) {
  const checks = [
    ["coordinated subprocesses", workload.coordinatedSubprocesses, budgets.gitSubprocesses],
    ["overlapping refresh subprocesses", workload.overlappingRefreshSubprocesses, budgets.gitOverlapSubprocesses],
    ["maximum parallel subprocesses", workload.maxParallelSubprocesses, budgets.gitMaxParallelSubprocesses],
    ["many-project maximum parallel subprocesses", workload.manyProjectMaxParallelSubprocesses, budgets.gitMaxParallelSubprocesses],
    ["slow command cancellation", workload.slowCommandMs, budgets.gitSlowCommandMs],
    ["many-project branch p95", workload.manyProjectBranchP95Ms, budgets.gitManyProjectP95Ms],
    ["untracked bytes read", workload.bytesRead, budgets.gitBytesRead],
  ];
  const failures = checks.flatMap(([scenario, actual, budget]) => {
    if (!Number.isFinite(actual)) return [`${scenario} was not reported by the Git fixture`];
    return actual > budget ? [`${scenario} ${actual.toFixed(1)} > budget ${budget}`] : [];
  });
  if (workload.coordinatedSubprocesses >= workload.baselineSubprocesses) failures.push(`coordinated subprocesses ${workload.coordinatedSubprocesses} did not improve measured baseline ${workload.baselineSubprocesses}`);
  if (workload.slowCommandState !== "error") failures.push(`slow command state ${workload.slowCommandState} != error`);
  return failures;
}
