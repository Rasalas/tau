import { describe, expect, it } from "vitest";
import { decideServerCall, gitWriteIn, hostOfWord, serverBypassIn, stricterLevel, type ServerCallRequest } from "./agent-gate";

describe("Git writes in a server command", () => {
  it.each([
    "git status",
    "git --no-pager log -n 5 --oneline",
    "git -C /srv/site diff HEAD~1",
    "git show HEAD:index.php | head",
    "git branch",
    "git branch -a -v",
    "git branch --list 'feat*'",
    "git tag",
    "git tag -l v1*",
    "git remote -v",
    "git config --get remote.origin.url",
    "git stash list",
    "git reflog",
    "git worktree list",
    "git --version",
    "git",
    "echo 'git commit -m x'",
    "grep -r git .",
    "ls .git",
    "cat /srv/site/.git/config",
    "which git",
    "command -v git",
  ])("lets %s through", (command) => {
    expect(gitWriteIn(command)).toBeUndefined();
  });

  it.each([
    ["git commit -m wip", "git commit"],
    ["git push", "git push"],
    ["git pull --rebase", "git pull"],
    ["git checkout main", "git checkout"],
    ["git reset --hard", "git reset"],
    ["git merge x", "git merge"],
    ["git stash", "git stash"],
    ["git stash pop", "git stash"],
    ["git add .", "git add"],
    ["git rm x", "git rm"],
    ["git clean -fd", "git clean"],
    ["git fetch", "git fetch"],
    ["git switch -c x", "git switch"],
    ["git restore index.php", "git restore"],
    ["git branch topic", "git branch"],
    ["git branch -D topic", "git branch"],
    ["git tag -a v1 -m v1", "git tag"],
    ["git config user.name x", "git config"],
    ["git -c alias.ci=commit ci -m x", "git ci"],
    ["git -C /srv/site commit -am x", "git commit"],
    ["/usr/bin/git commit", "git commit"],
    ["cd /srv/site && git add . && git commit -m deploy", "git add"],
    ["ls; git commit -m x", "git commit"],
    ["git status | cat && git push", "git push"],
    ["sudo -u www git pull", "git pull"],
    ["GIT_DIR=.git git commit", "git commit"],
    ["env GIT_AUTHOR_NAME=x git commit", "git commit"],
    ["sh -c \"git commit -m x\"", "git commit"],
    ["bash -lc 'git push origin main'", "git push"],
    ["timeout 10 git fetch", "git fetch"],
    ["nohup git gc &", "git gc"],
    ["echo $(git commit -m x)", "git commit"],
    ["if true; then git reset --hard; fi", "git reset"],
    ["xargs git add < files", "git add"],
    ["eval git commit", "git commit"],
  ])("refuses %s", (command, found) => {
    expect(gitWriteIn(command)).toBe(found);
  });
});

describe("a local command that reaches a server", () => {
  const targets = [
    { id: "a", label: "site", host: "example.com" },
    { id: "b", label: "fake", host: "127.0.0.1" },
  ];

  it("reads hosts from the ways tools write them", () => {
    expect(hostOfWord("deploy@example.com:/srv/site")).toBe("example.com");
    expect(hostOfWord("example.com:site/")).toBe("example.com");
    expect(hostOfWord("sftp://deploy@example.com:2222/srv")).toBe("example.com");
    expect(hostOfWord("ftp://example.com/x")).toBe("example.com");
    expect(hostOfWord("[::1]:22")).toBe("::1");
    expect(hostOfWord("example.com")).toBe("example.com");
  });

  it.each([
    ["ssh deploy@example.com ls", "ssh", "ls"],
    ["ssh -p 2222 -i key example.com 'git -C /srv status'", "ssh", "git -C /srv status"],
    ["ssh -o StrictHostKeyChecking=no localhost", "ssh", undefined],
    ["scp index.php deploy@example.com:/srv/site/", "scp", undefined],
    ["rsync -avz -e 'ssh -p 22' ./ example.com:/srv/site", "rsync", undefined],
    ["sftp -P 2222 tester@127.0.0.1", "sftp", undefined],
    ["lftp -e 'mirror -R' example.com", "lftp", undefined],
    ["curl -T index.php ftp://example.com/site/", "curl", undefined],
    ["curl --user x sftp://EXAMPLE.com/srv/index.php", "curl", undefined],
    ["npm test && sshpass -p x ssh example.com uptime", "ssh", "uptime"],
  ])("sees %s", (command, tool, remote) => {
    const found = serverBypassIn(command, targets);
    expect(found?.tool).toBe(tool);
    expect(found?.remoteCommand).toBe(remote);
  });

  it.each([
    "ssh other.org ls",
    "scp notes.txt backup.org:/x",
    "curl https://example.com/",
    "curl http://127.0.0.1:8080/",
    "rsync -a src/ dist/",
    "echo ssh example.com",
    "git push example.com",
    "cat example.com.txt",
  ])("ignores %s", (command) => {
    expect(serverBypassIn(command, targets)).toBeUndefined();
  });
});

describe("the decision for one server call", () => {
  const base: ServerCallRequest = { kind: "exec", target: { label: "site", address: "tester@example.com:22" }, targetLevel: "ask", command: "ls", where: "~/tmp" };

  it("takes the stricter of the target's and the thread's level", () => {
    expect(stricterLevel("full", "ask")).toBe("ask");
    expect(stricterLevel("ask", "full")).toBe("ask");
    expect(stricterLevel("full", undefined)).toBe("full");
    expect(stricterLevel("ask", "read-only")).toBe("read-only");
  });

  it("asks at ask, runs at full, refuses at read-only", () => {
    expect(decideServerCall(base)).toMatchObject({ kind: "ask", title: "Run on the server site?" });
    expect(decideServerCall(base).kind === "ask" && (decideServerCall(base) as { message: string }).message).toContain("ls");
    expect(decideServerCall({ ...base, targetLevel: "full" })).toEqual({ kind: "allow" });
    expect(decideServerCall({ ...base, targetLevel: "full", threadLevel: "ask" }).kind).toBe("ask");
    expect(decideServerCall({ ...base, targetLevel: "read-only" })).toMatchObject({ kind: "block", reason: expect.stringContaining("set to read-only") });
    expect(decideServerCall({ ...base, targetLevel: "full", threadLevel: "read-only" })).toMatchObject({ kind: "block", reason: expect.stringContaining("this thread is read-only") });
  });

  it("refuses Git writes at every level", () => {
    for (const targetLevel of ["read-only", "ask", "full"] as const) {
      expect(decideServerCall({ ...base, targetLevel, command: "git commit -am x" })).toMatchObject({ kind: "block", reason: expect.stringContaining("`git commit`") });
    }
    expect(decideServerCall({ ...base, kind: "bypass", tool: "ssh", command: "ssh example.com git push", remoteCommand: "git push", targetLevel: "full" }).kind).toBe("block");
    expect(decideServerCall({ ...base, kind: "bypass", tool: "ssh", command: "ssh example.com 'cd /srv && git push'", remoteCommand: "cd /srv", targetLevel: "full" }).kind).toBe("block");
  });

  it("asks once for a local command Access Kit already asks about", () => {
    const bypass: ServerCallRequest = { ...base, kind: "bypass", tool: "scp", command: "scp a example.com:/srv" };
    expect(decideServerCall(bypass).kind).toBe("ask");
    expect(decideServerCall({ ...bypass, threadLevel: "ask" })).toEqual({ kind: "allow" });
    expect(decideServerCall({ ...bypass, threadLevel: "full", targetLevel: "full" })).toEqual({ kind: "allow" });
    expect(decideServerCall({ ...bypass, threadLevel: "ask", targetLevel: "read-only" }).kind).toBe("block");
  });

  it("asks before writing to ~/tmp, and never reads the content as a command", () => {
    expect(decideServerCall({ ...base, kind: "put-tmp", command: "git commit", where: "~/tmp/probe.php" })).toMatchObject({ kind: "ask", title: "Write to ~/tmp on site?" });
  });
});
