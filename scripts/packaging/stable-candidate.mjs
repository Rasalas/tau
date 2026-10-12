// Weekly stable candidates are ordinary version-bump PRs. Merging one is the
// release approval; preparing or reminding about one never publishes an app.
import { execFileSync } from "node:child_process";
import { appChanged, shipless, VERSION_FILES } from "../../.github/scripts/nightly-changes.mjs";

export const CANDIDATE_PREFIX = "release/stable-";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const read = (ref, path) => git("show", `${ref}:${path}`);

function parts(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Not a stable version: ${version}`);
  return version.split(".").map(Number);
}
export function compareVersions(a, b) {
  const right = parts(b);
  for (const [index, value] of parts(a).entries()) if (value !== right[index]) return value - right[index];
  return 0;
}
export function nextPatch(version) {
  const [major, minor, patch] = parts(version);
  return `${major}.${minor}.${patch + 1}`;
}

/** Respect a deliberate unreleased version bump; otherwise prepare the next patch. */
export function candidatePlan({ files, readFile, previous, head, requestedVersion }) {
  if (!appChanged(files, readFile, previous, head)) return undefined;
  const old = JSON.parse(readFile(previous, "package.json")).version;
  const app = JSON.parse(readFile(head, "package.json"));
  if (compareVersions(app.version, old) < 0) throw new Error("main's version is behind the latest stable release.");
  const version = requestedVersion || (app.version === old ? nextPatch(old) : app.version);
  if (compareVersions(version, old) <= 0 || compareVersions(version, app.version) < 0) throw new Error("The candidate version must exceed the published stable and must not downgrade main.");
  const lock = JSON.parse(readFile(head, "package-lock.json"));
  if (lock.version !== app.version || lock.packages?.[""]?.version !== app.version) throw new Error("package.json and package-lock.json versions differ.");
  app.version = lock.version = lock.packages[""].version = version;
  const updates = {
    "package.json": `${JSON.stringify(app, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify(lock, null, 2)}\n`,
  };
  const kits = JSON.parse(readFile(head, "kits/package.json"));
  const oldKits = JSON.parse(readFile(previous, "kits/package.json"));
  const kitsChanged = appChanged(files.filter((file) => file.startsWith("kits/")), readFile, previous, head);
  if (kitsChanged && kits.version === oldKits.version) {
    kits.version = nextPatch(kits.version);
    updates["kits/package.json"] = `${JSON.stringify(kits, null, 2)}\n`;
  }
  return { version, kitsVersion: kits.version, updates };
}

export function candidateBody({ version, previous, head, subjects, reviewer, nightly }) {
  return `## Stable ${version}\n\n@${reviewer}, this is the stable release candidate for this week. Merge this PR to approve publishing; leaving it open or closing it publishes nothing.\n\n` +
    `Prepared from [${head.slice(0, 8)}](https://github.com/Rasalas/tau/commit/${head}), since ${previous}.\n\n` +
    (nightly ? `Latest nightly: [${nightly.tag_name}](https://github.com/Rasalas/tau/releases/tag/nightly), source ${nightly.target_commitish}. Confirm it covers the changes below before using it as release evidence.\n\n` : "No nightly is published yet.\n\n") +
    `## Changes\n\n${subjects.map((subject) => `- ${subject}`).join("\n")}\n\n` +
    `## Before merging\n\n- [ ] CI and performance checks are green.\n- [ ] Start a thread, choose a runtime/model, send a message and reopen the thread.\n- [ ] Check affected project/device flows in an isolated instance.\n- [ ] Larger changes have had at least a day of nightly use, or this is a targeted urgent fix.\n\n` +
    `After merge, the workflow tags the exact merge commit as v${version} and starts Release. Desktop and mobile uploads still require the release workflow's verification. Hotfixes can prepare this same PR at any time through Actions → Stable candidate → Run workflow.\n`;
}

function isCandidate(pr, repository) {
  return pr.user?.login === "github-actions[bot]" && pr.head?.repo?.full_name === repository && pr.base?.ref === "main" && pr.head.ref.startsWith(CANDIDATE_PREFIX);
}

/** GitHub API calls are kept here so tests can verify notifications without sending any. */
export async function prepareCandidate({ github, repo, reviewer, runId, requestedVersion, scheduled, checkout = { git, read } }) {
  const repository = `${repo.owner}/${repo.repo}`;
  const latest = (await github.rest.repos.getLatestRelease(repo)).data;
  if (!/^v\d+\.\d+\.\d+$/u.test(latest.tag_name)) throw new Error("The latest release is not a plain stable tag.");
  const previous = latest.tag_name;
  const published = previous.slice(1);
  const open = await github.paginate(github.rest.pulls.list, { ...repo, state: "open", base: "main", per_page: 100 });
  for (const pr of open.filter((entry) => isCandidate(entry, repository))) {
    const version = /^release\/stable-(\d+\.\d+\.\d+)-/u.exec(pr.head.ref)?.[1];
    if (!version) throw new Error("An open release candidate has an unknown branch format.");
    if (compareVersions(version, published) <= 0) {
      await github.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
      await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body: `${previous} is already published; this candidate is obsolete.` });
      continue;
    }
    if (requestedVersion && requestedVersion !== version) throw new Error("Close the existing release candidate before requesting a different version.");
    if (scheduled) await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body: `@${reviewer}, Tuesday's stable release reminder: this candidate is still waiting for your review. Merge it to publish, or close it to defer. The branch has not been rewritten.` });
    return { url: pr.html_url, existing: true };
  }
  const head = checkout.git("rev-parse", "HEAD");
  checkout.git("fetch", "origin", `refs/tags/${previous}:refs/tags/${previous}`);
  const files = checkout.git("diff", "--name-only", previous, head).split("\n").filter(Boolean);
  const plan = candidatePlan({ files, readFile: checkout.read, previous, head, requestedVersion });
  if (!plan) return { skipped: true };
  const subjects = [];
  for (const commit of checkout.git("rev-list", "--reverse", `${previous}..${head}`).split("\n").filter(Boolean)) {
    const changed = checkout.git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter(Boolean);
    if (changed.some((file) => !shipless(file))) subjects.push(checkout.git("show", "-s", "--format=%s", commit));
  }
  let nightly;
  try { nightly = (await github.rest.repos.getReleaseByTag({ ...repo, tag: "nightly" })).data; }
  catch (error) { if (error.status !== 404) throw error; }
  const base = (await github.rest.git.getCommit({ ...repo, commit_sha: head })).data;
  const tree = (await github.rest.git.createTree({ ...repo, base_tree: base.tree.sha, tree: Object.entries(plan.updates).map(([path, content]) => ({ path, content, mode: "100644", type: "blob" })) })).data;
  const commit = (await github.rest.git.createCommit({ ...repo, message: `chore: prepare stable ${plan.version}`, tree: tree.sha, parents: [head] })).data;
  const branch = `${CANDIDATE_PREFIX}${plan.version}-${runId}`;
  await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: commit.sha });
  const pr = (await github.rest.pulls.create({ ...repo, base: "main", head: branch, title: `Release v${plan.version}`, body: candidateBody({ ...plan, previous, head, subjects, reviewer, nightly }) })).data;
  await github.rest.issues.addAssignees({ ...repo, issue_number: pr.number, assignees: [reviewer] });
  await github.rest.pulls.requestReviewers({ ...repo, pull_number: pr.number, reviewers: [reviewer] });
  // Explicit dispatches work with GITHUB_TOKEN, including on bot-created branches.
  for (const workflow_id of ["ci.yml", "performance.yml"]) await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id, ref: branch });
  return { url: pr.html_url, version: plan.version, existing: false };
}

/** Validate the approved version-only PR, then tag its exact merge and dispatch publishing. */
export async function publishCandidate({ github, repo, pr, checkout = { git, read } }) {
  if (!pr.merged || !isCandidate(pr, `${repo.owner}/${repo.repo}`)) return { skipped: true };
  const sha = pr.merge_commit_sha;
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("The merged candidate has no commit SHA.");
  const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 });
  if (!files.length || files.some((file) => !VERSION_FILES.includes(file.filename))) throw new Error("A release candidate may change only version files.");
  // Contents and workflows come from the merged main commit, never a fork's checkout.
  const app = JSON.parse(checkout.read(sha, "package.json"));
  const lock = JSON.parse(checkout.read(sha, "package-lock.json"));
  parts(app.version);
  if (!pr.head.ref.startsWith(`${CANDIDATE_PREFIX}${app.version}-`) || lock.version !== app.version || lock.packages?.[""]?.version !== app.version) throw new Error("The merged candidate's versions do not match its branch.");
  const previous = checkout.git("rev-parse", `${sha}^1`);
  for (const file of files) {
    const before = JSON.parse(checkout.read(previous, file.filename));
    const after = JSON.parse(checkout.read(sha, file.filename));
    delete before.version; delete after.version;
    if (file.filename === "package-lock.json") { delete before.packages[""].version; delete after.packages[""].version; }
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`The candidate changed more than a version in ${file.filename}.`);
  }
  const tag = `v${app.version}`;
  const latest = (await github.rest.repos.getLatestRelease(repo)).data;
  if (!/^v\d+\.\d+\.\d+$/u.test(latest.tag_name)) throw new Error("The latest release is not a plain stable tag.");
  if (compareVersions(latest.tag_name.slice(1), app.version) > 0) throw new Error("A newer stable release is already published.");
  try {
    const existing = (await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` })).data;
    if (existing.object.sha !== sha) throw new Error(`${tag} already belongs to another commit.`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha });
  }
  if (latest.tag_name === tag) return { tag, sha, published: true };
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, { ...repo, workflow_id: "release.yml", head_sha: sha, event: "workflow_dispatch", per_page: 100 });
  if (runs.some((run) => run.head_branch === tag && (run.status !== "completed" || run.conclusion === "success"))) return { tag, sha, dispatched: true };
  // A tag pushed by GITHUB_TOKEN does not trigger another workflow automatically.
  await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: "release.yml", ref: tag, inputs: { publish: "true" } });
  await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body: `Stable ${tag} was approved. The exact merge commit ${sha} is tagged and the [Release workflow](https://github.com/${repo.owner}/${repo.repo}/actions/workflows/release.yml) has been started. Build and upload results appear there.` });
  return { tag, sha };
}
