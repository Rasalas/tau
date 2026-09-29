# Cutover: from the private repository to a public one

The private `Rasalas/tau` becomes `Rasalas/tau-private`. A new public `Rasalas/tau`
gets the rewritten history (`rewrite-history.sh`), and the next release is built
there on GitHub-hosted runners. Run the steps in order; each has a command and a
check, and the next step waits until the check passes.

Why the order matters: once the new repository exists, `github.com/Rasalas/tau`
is the public one. Every checkout still pointing there would push the old,
unrewritten history into it. So every remote moves to `tau-private` (step 4)
before the new repository is created (step 7).

## What you need

- `gh` logged in as the owner, with the scopes `repo` and `workflow`
  (`gh auth status`). Pushing `.github/workflows/` needs `workflow`.
- `git-filter-repo`, `python3`, `gitleaks`, Node 22.
- The private inputs outside Git: `mailmap`, `replace-text.txt`,
  `replace-message.txt`.
- The secret values, from the vault. GitHub never shows a secret again, so
  nothing can be copied from the old repository:

  | Secret | Value |
  |---|---|
  | `TAU_RELEASE_SIGNING_KEY` | Ed25519 private key, PKCS#8 PEM (public key `8hB4AtWu…` in `src/shared/release-keys.ts`) |
  | `TAU_RELEASES_APP_ID` | ID of the GitHub App "Tau Releases (Rasalas)" |
  | `TAU_RELEASES_APP_KEY` | a private key of that app, PEM; if it is lost, generate a new one in the app's settings and delete the old one |
  | `CSC_LINK` | `base64 -i <Developer ID Application>.p12` |
  | `CSC_KEY_PASSWORD` | the `.p12`'s password |
  | `APPLE_API_KEY_P8` | the App Store Connect API key (`.p8` contents); Apple offers the download once, so a lost one means a new key |
  | `APPLE_API_KEY_ID` | that key's ID |
  | `APPLE_API_ISSUER` | its issuer ID |

Variables used below (fill in the paths):

```bash
OLD=<the checkout whose .git all worktrees share>
MAIN=<a clean worktree of $OLD with main checked out>
PRIVATE=<folder with mailmap, replace-text.txt, replace-message.txt>
WORK=/tmp/tau-public-$(date +%Y%m%d-%H%M)
NEW=<where the new clone goes>
```

## 1. Freeze

Stop every agent, Tau thread and script that could push while this runs.
Merge or close the open pull requests; they stay in `tau-private`.

```bash
git -C "$MAIN" status --short --branch            # "## main...origin/main", nothing else
cd "$MAIN" && npm ci && npm run lint && npm run typecheck && npm test
grep '"version"' "$MAIN/package.json"
gh pr list --repo Rasalas/tau --state open
```

Check: tests green; `package.json` has the version to release (0.7.14); no open
pull request you still want to merge in the old repository.

## 2. Switch the old repository's Actions off

Its workflows now name hosted runners, which cost minutes on a private
repository; nothing needs to run there any more.

```bash
gh api -X PUT repos/Rasalas/tau/actions/permissions -F enabled=false
git -C "$OLD" push origin main
```

Check:

```bash
gh api repos/Rasalas/tau/actions/permissions --jq .enabled      # false
test "$(git -C "$OLD" ls-remote origin refs/heads/main | cut -f1)" = "$(git -C "$OLD" rev-parse main)" && echo "main pushed"
```

## 3. Rename

```bash
gh repo rename tau-private --repo Rasalas/tau --yes
```

Check:

```bash
gh api repos/Rasalas/tau-private --jq '[.full_name, .private] | @tsv'   # Rasalas/tau-private  true
gh api repos/Rasalas/tau --jq .full_name                               # Rasalas/tau-private (GitHub's redirect: no new repository yet)
```

The redirect ends the moment step 7 creates the new repository.

## 4. Point every checkout at `tau-private`

All worktrees share the one `.git/config`, so one command moves them:

```bash
git -C "$OLD" remote set-url origin https://github.com/Rasalas/tau-private.git
```

A guard for everything the remote does not cover (a URL typed by hand, a tool
that passes its own): a `pre-push` hook in the shared `.git`, which every
worktree runs.

```bash
hooks="$(git -C "$OLD" rev-parse --git-common-dir)/hooks"
cat > "$hooks/pre-push" <<'EOF'
#!/bin/sh
# This checkout holds the history from before the public start; the public repository must never receive it.
case "$2" in
  *[:/]Rasalas/tau|*[:/]Rasalas/tau.git|*[:/]Rasalas/tau/)
    echo "pre-push: $2 is the public repository; this checkout holds the history from before the public start." >&2
    exit 1 ;;
esac
EOF
chmod +x "$hooks/pre-push"
```

Check, on this machine:

```bash
# Every worktree pushes to tau-private (worktreeConfig could override per worktree).
git -C "$OLD" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do
  printf '%s\t%s\n' "$(git -C "$wt" remote get-url --push origin)" "$wt"
done | grep -v 'Rasalas/tau-private' || echo "all worktrees push to tau-private"
# No other remote or pushurl names the old URL.
git -C "$OLD" config --get-regexp '^remote\..*\.(url|pushurl)$' | grep -E 'Rasalas/tau(\.git)?/?$' || echo "no remote names Rasalas/tau"
# The hook stops a push to the old name.
git -C "$OLD" push --dry-run https://github.com/Rasalas/tau.git main 2>&1 | grep -q '^pre-push:' && echo "hook blocks Rasalas/tau"
```

Then find every other checkout, on this Mac, on rex and on any other machine
with a clone, and do the same there (`remote set-url`, hook, checks):

```bash
find ~ /Volumes -maxdepth 7 -path '*/.git/config' -not -path '*/node_modules/*' 2>/dev/null \
  | xargs grep -lE 'github\.com[:/]Rasalas/tau(\.git)?/?$' 2>/dev/null
```

Check: the `find` prints nothing on every machine. The runners' own checkouts
(`_work/`) go away with the runners in step 5.

## 5. Remove the self-hosted runners

They were attached to `Rasalas/tau` and are now attached to `tau-private`. A
public repository must never have them.

```bash
gh api repos/Rasalas/tau-private/actions/runners --jq '.runners[] | [.id, .name, .status] | @tsv'
token() { gh api -X POST repos/Rasalas/tau-private/actions/runners/remove-token --jq .token; }
```

On the Mac (`macos-runner-tau`); only the service whose label contains
`Rasalas-tau`, other runners on the machine belong to other repositories:

```bash
dir="$(plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/actions.runner.Rasalas-tau.macos-runner-tau.plist)"
cd "$dir" && ./svc.sh stop && ./svc.sh uninstall && ./config.sh remove --token "$(token)"
```

Check: `launchctl list | grep actions.runner.Rasalas-tau` prints nothing.

On rex (`rex-runner-tau`); create the token on the Mac with `token` and paste it:

```bash
systemctl list-units --all 'actions.runner.Rasalas-tau.*'
dir="$(systemctl show -p WorkingDirectory --value actions.runner.Rasalas-tau.rex-runner-tau.service)"
cd "$dir" && sudo ./svc.sh stop && sudo ./svc.sh uninstall && ./config.sh remove --token <token>
```

Check: `systemctl list-units --all 'actions.runner.Rasalas-tau.*'` lists nothing.

`gh-runner-tau` is offline and has no machine to run `config.sh` on; remove its
registration, and any other that is left, through the API:

```bash
for name in gh-runner-tau rex-runner-tau macos-runner-tau; do
  id="$(gh api repos/Rasalas/tau-private/actions/runners --jq ".runners[] | select(.name == \"$name\") | .id")"
  [ -z "$id" ] || gh api -X DELETE "repos/Rasalas/tau-private/actions/runners/$id"
done
```

Check: `gh api repos/Rasalas/tau-private/actions/runners --jq .total_count` is `0`.
The runner folders (`$dir`) can be deleted afterwards.

## 6. Rewrite the history in a mirror under /tmp

Never in `$OLD`. The script clones a mirror, keeps `main` and the `v*` tags,
and drops every other ref.

```bash
"$MAIN/scripts/open-source/rewrite-history.sh" --source "$OLD" --work "$WORK" --private-dir "$PRIVATE" \
  --main refs/heads/main --messages 2>&1 | tee "$WORK.log"; echo "exit ${PIPESTATUS[0]}"
```

Checks (the numbers are those of the rehearsal on 2026-09-29; small changes
from newer commits are fine, new kinds of hits are not):

```bash
grep "^main's tree is unchanged" "$WORK.log"
grep '^private values remaining: 0$' "$WORK/after.txt"
sed -n '/^identities/,/^messages/p' "$WORK/after.txt"       # only the noreply address from the mailmap, and GitHub's own
grep -E '^(refs|commits|messages naming|home LAN|/Volumes path|/Users path)' "$WORK/after.txt"
git -C "$WORK/tau.git" for-each-ref --format='%(refname)' | grep -vcE '^refs/(heads/main|tags/v)'   # 0
GOMAXPROCS=2 nice -n 19 gitleaks git "$WORK/tau.git" --redact --no-banner --report-format json --report-path "$WORK/gitleaks.json"
python3 -c "import json; [print(f['RuleID'], f['File']) for f in json.load(open('$WORK/gitleaks.json'))]"
git -C "$WORK/tau.git" count-objects -vH | grep size-pack
```

- The script ends with `exit 0` and prints `main's tree is unchanged`: the published
  files are exactly `main`'s.
- `private values remaining: 0`: no value from the private inputs, in files,
  messages, identities, tag texts or paths.
- `messages naming T3 / T3 Code`: 2 (the `t3.json` compatibility format, the
  example theme's old name); `messages naming agent product name`: 5, each a
  code identifier (package, CLI, paths, environment variable).
- `home LAN`: 0. `/Volumes path`: 1 and `/Users path`: 6, all made-up test
  fixtures (`/Volumes/Data/ff`, `/Users/me`, `/Users/dev`, …); the `ts.net`
  names and `100.x` addresses are fixtures too.
- gitleaks: 14 findings, the test dummies K109 listed (`kits/*/host.test.ts`,
  `account-identity.test.ts`, the Laravel fixture's `.env`, the push kit's
  test key, `runtime-controls.tsx`, `benchmarks/host-transfer-turn.json`).
- Rehearsal sizes: 2,949 commits on `main` became 2,944 (commits that touched
  only removed paths); 23 tags; 18.4 MiB of objects before, 13.8 MiB after.

Keep `$WORK/tau.git/filter-repo/commit-map` (old → new commit ids) next to the
private inputs, outside Git: tickets and old notes name old commits.

## 7. Create the new repository, private for now

From here on, `github.com/Rasalas/tau` is the new repository.

```bash
gh repo create Rasalas/tau --private --disable-wiki \
  --description "$(gh repo view Rasalas/tau-private --json description --jq .description)" \
  --homepage https://rasalas.github.io/tau/
gh api -X PUT repos/Rasalas/tau/actions/permissions -F enabled=false
```

Actions stay off until the environments and secrets exist (step 10); a push
must not start a workflow before that.

Check:

```bash
gh api repos/Rasalas/tau --jq '[.full_name, .private, .size] | @tsv'    # Rasalas/tau  true  0
gh api repos/Rasalas/tau/actions/permissions --jq .enabled              # false
git -C "$OLD" remote get-url origin                                     # still …/tau-private.git
```

## 8. Push `main` and the tags

From the mirror, never from `$OLD`:

```bash
git -C "$WORK/tau.git" push https://github.com/Rasalas/tau.git refs/heads/main:refs/heads/main
git -C "$WORK/tau.git" push https://github.com/Rasalas/tau.git 'refs/tags/v*:refs/tags/v*'
```

Check:

```bash
diff <(git -C "$WORK/tau.git" for-each-ref --format='%(objectname) %(refname)' | sort -k2) \
     <(git ls-remote https://github.com/Rasalas/tau.git | awk '{print $1, $2}' | grep -v '\^{}' | sort -k2) && echo "remote equals the mirror"
gh api 'repos/Rasalas/tau/commits?per_page=100' --jq '.[].commit | .author.email, .committer.email' | sort -u
```

The second prints only the noreply address and `noreply@github.com`.

## 9. Make it public

Last look before it is visible: the repository page, a few old commits, the
tags. Then:

```bash
gh repo edit Rasalas/tau --visibility public --accept-visibility-change-consequences
```

Check: `gh api repos/Rasalas/tau --jq .visibility` is `public`.

## 10. Environments and secrets

```bash
gh api -X PUT repos/Rasalas/tau/environments/release --input - <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
gh api -X POST repos/Rasalas/tau/environments/release/deployment-branch-policies -f name=main -f type=branch
gh api -X POST repos/Rasalas/tau/environments/release/deployment-branch-policies -f name='v*' -f type=tag
gh api -X PUT repos/Rasalas/tau/environments/release-dry-run

# Each value from the vault; gh reads it from stdin (a file) or asks.
gh secret set TAU_RELEASE_SIGNING_KEY --repo Rasalas/tau --env release < <signing key .pem>
gh secret set TAU_RELEASES_APP_ID     --repo Rasalas/tau --env release
gh secret set TAU_RELEASES_APP_KEY    --repo Rasalas/tau --env release < <app key .pem>
base64 -i <Developer ID>.p12 | gh secret set CSC_LINK --repo Rasalas/tau --env release
gh secret set CSC_KEY_PASSWORD        --repo Rasalas/tau --env release
gh secret set APPLE_API_KEY_P8        --repo Rasalas/tau --env release < <AuthKey_….p8>
gh secret set APPLE_API_KEY_ID        --repo Rasalas/tau --env release
gh secret set APPLE_API_ISSUER        --repo Rasalas/tau --env release
```

No required reviewers on `release`: they would hold every scheduled nightly
until someone approves it. No repository-level secrets, and no variable
`NIGHTLY` until the nightly should run (docs/RELEASE.md, Nightly builds).

Check:

```bash
gh secret list --repo Rasalas/tau --env release | cut -f1 | sort   # the eight names above
gh secret list --repo Rasalas/tau                                  # empty
gh api repos/Rasalas/tau/environments --jq '.environments[].name'  # release, release-dry-run
gh api repos/Rasalas/tau/environments/release/deployment-branch-policies --jq '.branch_policies[] | [.type, .name] | @tsv'   # branch main, tag v*
```

## 11. Settings

```bash
# Actions on, only GitHub's own actions plus the release action, every action pinned to a full commit SHA.
gh api -X PUT repos/Rasalas/tau/actions/permissions -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api -X PUT repos/Rasalas/tau/actions/permissions/selected-actions --input - <<'EOF'
{"github_owned_allowed": true, "verified_allowed": false, "patterns_allowed": ["softprops/action-gh-release@*"]}
EOF
# The workflow token reads only; workflows cannot approve pull requests.
gh api -X PUT repos/Rasalas/tau/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
# Fork pull requests from anyone outside wait for approval, not only first-time contributors.
gh api -X PUT repos/Rasalas/tau/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors
# Security reports arrive privately (SECURITY.md points there); secret scanning with push protection.
gh api -X PUT repos/Rasalas/tau/private-vulnerability-reporting
gh api -X PATCH repos/Rasalas/tau --input - <<'EOF'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}}}
EOF
# The issue forms add it; GitHub drops a label that does not exist.
gh label create needs-triage --repo Rasalas/tau --color d4c5f9 --description "Not looked at yet"
gh repo edit Rasalas/tau --enable-projects=false
```

Recommended, for the integrator to decide: a ruleset that forbids force
pushes to and deletion of `main`, and one that forbids deleting or moving
`v*` tags. Never one that covers the tag `nightly`, and no immutable releases:
the nightly replaces its release and tag every time.

```bash
gh api -X POST repos/Rasalas/tau/rulesets --input - <<'EOF'
{"name": "main", "target": "branch", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
 "rules": [{"type": "deletion"}, {"type": "non_fast_forward"}]}
EOF
gh api -X POST repos/Rasalas/tau/rulesets --input - <<'EOF'
{"name": "release tags", "target": "tag", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
 "rules": [{"type": "deletion"}, {"type": "update"}]}
EOF
```

Check:

```bash
gh api repos/Rasalas/tau/actions/permissions                              # enabled, selected, sha_pinning_required true
gh api repos/Rasalas/tau/actions/permissions/workflow                     # read, false
gh api repos/Rasalas/tau/actions/permissions/fork-pr-contributor-approval # all_external_contributors
gh api repos/Rasalas/tau/private-vulnerability-reporting --jq .enabled    # true
gh label list --repo Rasalas/tau --search needs-triage
```

## 12. The GitHub App stays on `tau-releases` only

```bash
gh api /user/installations --jq '.installations[] | [.id, .app_slug, .repository_selection] | @tsv'
gh api /user/installations/<id of the Tau Releases app>/repositories --jq '.repositories[].full_name'
```

Check: `repository_selection` is `selected` and the only repository is
`Rasalas/tau-releases`. The new `Rasalas/tau` publishes its own release with
the workflow's `GITHUB_TOKEN`.

## 13. Pages

```bash
gh api -X POST repos/Rasalas/tau/pages -f build_type=workflow
gh workflow run pages.yml --repo Rasalas/tau --ref main
gh run watch --repo Rasalas/tau "$(gh run list --repo Rasalas/tau --workflow pages.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Check: `gh api repos/Rasalas/tau/pages --jq '[.build_type, .html_url] | @tsv'`
prints `workflow` and `https://rasalas.github.io/tau/`, and
`curl -sI https://rasalas.github.io/tau/ | head -1` answers 200.

## 14. First runs

CI and the performance gates, which did not run for the pushed history:

```bash
gh workflow run ci.yml --repo Rasalas/tau --ref main
gh workflow run performance.yml --repo Rasalas/tau --ref main
gh run list --repo Rasalas/tau --limit 5
```

Check: both green. The three `test (n/3)` logs together list as many test
files as a full local run (`Test Files` lines).

A release dry run on `main`; it runs in `release`, so it signs and notarizes
without publishing anything:

```bash
gh workflow run release.yml --repo Rasalas/tau --ref main -f publish=false
id="$(gh run list --repo Rasalas/tau --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch --repo Rasalas/tau "$id"
gh run download "$id" --repo Rasalas/tau --dir /tmp/tau-dry-run
```

Check:

- every job green; the macOS job's "Select Xcode" prints Xcode 26.6 and
  `actool`; its Package log compiles `Icon.icon`, signs with the Developer ID
  (no `skipped macOS application code signing`) and notarizes both apps;
- the `sign` log names the key `8hB4AtWu…`, and `tau-signatures` holds three
  `.sig` files;
- locally: copy the three `.sig` files next to the feeds from `tau-macos`,
  `tau-linux` and `tau-windows`, then
  `node scripts/packaging/release-signing.mjs check <folder>/latest*.yml`;
- the `.dmg` for this Mac, mounted: `spctl -a -vv /Volumes/Tau*/Tau.app` says
  `source=Notarized Developer ID`;
- no release appeared: `gh release list --repo Rasalas/tau` is empty and
  `tau-releases` is unchanged.

## 15. Release 0.7.14

The tag goes on the new history, so it is made in a fresh clone, never in `$OLD`.

```bash
git clone https://github.com/Rasalas/tau.git "$NEW"
cp "$(git -C "$OLD" rev-parse --git-common-dir)/hooks/commit-msg" "$NEW/.git/hooks/"
git -C "$NEW" config user.email <the noreply address from the mailmap>
grep '"version": "0.7.14"' "$NEW/package.json"
git -C "$NEW" tag v0.7.14 main
git -C "$NEW" push origin v0.7.14
```

Check, once the run is green:

```bash
gh release view v0.7.14 --repo Rasalas/tau-releases --json assets --jq '.assets[].name' | sort
for name in latest-mac.yml latest-mac.yml.sig Tau-mac-arm64.dmg Tau-mac-x64.dmg Tau-windows-x64.exe Tau-linux-amd64.deb Tau-linux-x86_64.AppImage; do
  printf '%s ' "$name"; curl -so /dev/null -w '%{http_code}\n' -L "https://github.com/Rasalas/tau-releases/releases/latest/download/$name"
done
npm --prefix "$NEW" run install:mac
```

- `tau-releases` has the installers, their blockmaps, three feeds with their
  `.sig`, `LICENSE` and the five fixed names; each URL answers 200 without a
  login; `install:mac` installs 0.7.14.
- `Rasalas/tau` has the same release without the fixed names. Its generated
  notes are empty (the new repository has no pull requests); put the notes in
  with `gh release edit v0.7.14 --repo Rasalas/tau --notes-file <notes>` and the
  same for `Rasalas/tau-releases`.
- An installed 0.7.13 (feed `Rasalas/tau`) now finds 0.7.14 in the public
  repository. On macOS it cannot install it (the old build is not signed like
  the new one): install once by hand.
- Then the package managers (docs/RELEASE.md, Package managers).

## 16. Afterwards

- **Work continues in `$NEW`.** The old checkout and its worktrees keep the old
  history and push to `tau-private`; their commit ids do not exist in the
  public repository.
- **Carry an unfinished branch over** without its old commits' metadata:

  ```bash
  cd "$NEW"
  git fetch "$OLD" "refs/heads/<branch>:refs/old/<branch>" "refs/heads/main:refs/old/main"
  git switch -c <branch> refs/old/<branch>
  git rebase --onto main "$(git merge-base refs/old/<branch> refs/old/main)" \
    --exec 'git commit --amend --no-edit --reset-author'
  git for-each-ref --format='delete %(refname)' refs/old | git update-ref --stdin
  ```

  Before pushing it: `git log --format='%ae %ce' main..HEAD | sort -u` prints
  only the noreply address, and the messages name no private value.
- **Old secrets.** `tau-private` still holds the release secrets. Once the
  first public release worked, delete them there:
  `for n in $(gh secret list --repo Rasalas/tau-private | cut -f1); do gh secret delete "$n" --repo Rasalas/tau-private; done`.
- **Links.** Issue and pull request links to `Rasalas/tau/…` from before the
  cutover now point into the public repository; the old ones live under
  `Rasalas/tau-private`.
- **Clean up.** `rm -rf "$WORK" "$WORK.log" /tmp/tau-dry-run`. `$WORK/replace-text.txt`
  holds the private values.

## If it goes wrong

- **Before step 9 (still private):** `gh repo delete Rasalas/tau --yes` (needs
  the `delete_repo` scope), `gh repo rename tau --repo Rasalas/tau-private --yes`,
  and point the remotes back. Runners removed in step 5 have to be registered
  again from the repository's Settings → Actions → Runners.
- **After step 9:** a public repository may have been cloned or forked. A
  value that leaked is rotated, not deleted: new signing key (docs/host-updates.md,
  Rotating the key), new app key, new API key.
