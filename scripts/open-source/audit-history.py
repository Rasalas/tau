#!/usr/bin/env python3
"""Counts what a public history would expose: identities, personal-data patterns in every blob, names in messages."""
import collections, re, subprocess, sys

repo = sys.argv[1] if len(sys.argv) > 1 else "."
git = lambda *a, **k: subprocess.run(["git", "-C", repo, *a], capture_output=True, **k)

PATTERNS = {
    "ts.net host": rb"[A-Za-z0-9.-]+\.ts\.net",
    "CGNAT/Tailscale IP": rb"\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b",
    "192.168.1.x": rb"\b192\.168\.178\.\d{1,3}\b",
    "/Volumes path": rb"/Volumes/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+",
    "/Users path": rb"/Users/[A-Za-z0-9._-]+",
    "e-mail (non-example)": rb"[A-Za-z0-9._%+-]+@(?!example\.|[a-z.]*\.invalid|[a-z.]*\.test\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}",
}
MESSAGE_PATTERNS = {
    "T3 / T3 Code": r"(?i)\bt3 ?code\b|\bT3\b|t3-parity|\bt3/",
    "agent product name": r"(?i)\bcl" r"aude\b",
    "Co-Authored-By": r"(?i)co-authored-by",
}

refs = git("for-each-ref", "--format=%(refname)", text=True).stdout.split()
print(f"refs: {len(refs)}  ({collections.Counter('/'.join(r.split('/')[:2]) for r in refs)})")
print(f"commits: {git('rev-list', '--all', '--count', text=True).stdout.strip()}")
idents = collections.Counter(git("log", "--all", "--format=%an <%ae>%n%cn <%ce>", text=True).stdout.splitlines())
print("identities (author+committer lines):")
for ident, n in idents.most_common(): print(f"  {n:6}  {ident}")

messages = git("log", "--all", "--format=%B%x00", text=True).stdout.split("\0")
for name, rx in MESSAGE_PATTERNS.items():
    print(f"messages naming {name}: {sum(1 for m in messages if re.search(rx, m))}")

objects = git("rev-list", "--all", "--objects", text=True).stdout.splitlines()
paths = {}
for line in objects:
    sha, _, path = line.partition(" ")
    paths.setdefault(sha, path)
check = git("cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)", input="\n".join(paths), text=True).stdout.split("\n")
blobs = [f[0] for f in (l.split() for l in check) if len(f) == 3 and f[1] == "blob" and int(f[2]) < 5_000_000]
sizes = sorted(((int(f[2]), paths[f[0]]) for f in (l.split() for l in check) if len(f) == 3 and f[1] == "blob"), reverse=True)
print(f"blobs: {len(blobs)}; largest: " + ", ".join(f"{p} {s // 1024} KB" for s, p in sizes[:3]))

hits = {k: collections.Counter() for k in PATTERNS}
where = {k: collections.defaultdict(set) for k in PATTERNS}
proc = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
import threading
def feed():
    for b in blobs: proc.stdin.write(f"{b}\n".encode())
    proc.stdin.close()
threading.Thread(target=feed, daemon=True).start()
for _ in blobs:
    sha, _, size = proc.stdout.readline().split()
    data = proc.stdout.read(int(size)); proc.stdout.read(1)
    if b"\0" in data[:8000]: continue
    for key, rx in PATTERNS.items():
        for m in re.findall(rx, data):
            value = m.decode(errors="replace")
            hits[key][value] += 1
            where[key][value].add(paths[sha.decode()])
for key in PATTERNS:
    print(f"{key}: {len(hits[key])} distinct")
    for value, n in hits[key].most_common(40):
        print(f"  {n:5}  {value}  ({', '.join(sorted(where[key][value])[:2])})")
