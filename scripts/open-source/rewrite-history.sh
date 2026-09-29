#!/usr/bin/env bash
# Rewrites a throwaway mirror of Tau's history for publication; never a working checkout.
#
#   scripts/open-source/rewrite-history.sh --source <repo path or URL> --work /tmp/tau-public \
#     --private-dir <dir with mailmap + replace-text.txt> [--main <ref>] [--messages]
#
# Keeps refs/heads/main and refs/tags/v*; drops every other ref (branches, tool checkpoints).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
source="" work="" private="" main_ref="refs/heads/main" messages=0
while [ $# -gt 0 ]; do
  case "$1" in
    --source) source="$2"; shift 2 ;;
    --work) work="$2"; shift 2 ;;
    --private-dir) private="$2"; shift 2 ;;
    --main) main_ref="$2"; shift 2 ;;
    --messages) messages=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$source" ] && [ -n "$work" ] && [ -n "$private" ] || { sed -n 2,7p "$0" >&2; exit 2; }
case "$work" in /tmp/*|/private/tmp/*|"${TMPDIR:-/nonexistent}"*) ;; *) echo "--work must be under /tmp" >&2; exit 2 ;; esac
[ ! -e "$work" ] || { echo "$work exists; pick a fresh directory" >&2; exit 2; }
for f in mailmap replace-text.txt; do [ -f "$private/$f" ] || { echo "missing $private/$f" >&2; exit 2; }; done

mkdir -p "$work"
repo="$work/tau.git"
git clone --quiet --mirror --no-local "$source" "$repo"
git -C "$repo" remote remove origin

main_sha="$(git -C "$repo" rev-parse --verify "$main_ref^{commit}")"
git -C "$repo" for-each-ref --format='delete %(refname)' | grep -v -E ' refs/tags/v' | git -C "$repo" update-ref --stdin
git -C "$repo" update-ref refs/heads/main "$main_sha"
git -C "$repo" symbolic-ref HEAD refs/heads/main
git -C "$repo" reflog expire --expire=now --all
git -C "$repo" gc --quiet --prune=now

python3 "$here/audit-history.py" "$repo" > "$work/before.txt"
git -C "$repo" for-each-ref --format='%(objectname) %(refname)' > "$work/refs-before.txt"

cat "$here/replace-text.txt" "$private/replace-text.txt" > "$work/replace-text.txt"
args=(--force --mailmap "$private/mailmap" --replace-text "$work/replace-text.txt"
      --invert-paths --paths-from-file "$here/remove-paths.txt")
if [ "$messages" = 1 ]; then
  cat "$here/replace-message.txt" > "$work/replace-message.txt"
  [ -f "$private/replace-message.txt" ] && cat "$private/replace-message.txt" >> "$work/replace-message.txt"
  args+=(--replace-message "$work/replace-message.txt")
fi
(cd "$repo" && nice -n 19 git filter-repo "${args[@]}")

status=0
python3 "$here/audit-history.py" "$repo" --private-dir "$private" > "$work/after.txt" || status=$?
git -C "$repo" for-each-ref --format='%(objectname) %(refname)' > "$work/refs-after.txt"
echo "done: $repo"
echo "compare: diff $work/before.txt $work/after.txt"
echo "old -> new commit ids: $repo/filter-repo/commit-map"
# The current state was cleaned on a branch before, so main's files should come out unchanged.
old_tree="$(git -C "$source" rev-parse "$main_sha^{tree}" 2>/dev/null || echo unknown)"
new_tree="$(git -C "$repo" rev-parse 'refs/heads/main^{tree}')"
if [ "$old_tree" = "$new_tree" ]; then echo "main's tree is unchanged ($new_tree)"; else echo "main's tree changed: $old_tree -> $new_tree" >&2; status=1; fi
[ "$status" = 3 ] && echo "private values remain; see the private lines in $work/after.txt" >&2
exit "$status"
