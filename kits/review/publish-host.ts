import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { WORKSPACE_HOST_EXTENSION_ID, type PublishInfo, type PublishResult, type RequestService, type ReviewRequestContext } from "./protocol.js";
import {
  accountArgs,
  authArgs,
  createRepositoryArgs,
  defaultCliRunner,
  githubCreatedRepository,
  gitlabCreatedRepository,
  gitlabCreateProjectArgs,
  gitlabNamespaceArgs,
  isRepositoryPath,
  parseAccount,
  protocolArgs,
  SERVICES,
  type CliRunner,
  type CreatedRepository,
  type RemoteProtocol,
  type RepositoryVisibility,
} from "./request-cli.js";

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const SERVICE_LIST: readonly RequestService[] = ["github", "gitlab"];

/**
 * "Publish repository" for a checkout without a remote, as T3 Code offers it:
 * `gh repo create` or GitLab's API through `glab`, then `origin` and a push.
 * Nothing is created unless the call carries `confirm: true`, which only the
 * form's last step sends.
 */
export function registerPublishCommands(context: HostExtensionContext, options: { run?: CliRunner } = {}): void {
  const { services } = context;
  const run = options.run ?? defaultCliRunner;

  const workspace = async <T>(command: string, input?: unknown): Promise<T> => {
    try {
      return await context.invokeHostExtension(WORKSPACE_HOST_EXTENSION_ID, command, input) as T;
    } catch (error) {
      throw new HostCommandError(message(error));
    }
  };
  const cli = (service: RequestService, args: string[], cwd: string): Promise<string> => {
    const command = services.findCommand(SERVICES[service].tool);
    if (!command) throw new HostCommandError(`${SERVICES[service].label} is not installed or not on your PATH.`);
    services.noteSubprocess();
    return run(command, args, cwd);
  };

  context.registerCommand("publish-info", async (): Promise<PublishInfo> => {
    const git = await workspace<ReviewRequestContext>("review-request-context");
    const answers = await Promise.all(SERVICE_LIST.map(async (service) => {
      const facts = SERVICES[service];
      if (!services.findCommand(facts.tool)) return { service, ready: false, problem: `${facts.label} is not installed.` };
      const signedIn = await cli(service, authArgs(), git.root).then(() => true, () => false);
      if (!signedIn) return { service, ready: false, problem: `${facts.label} is not signed in. Run \`${facts.login}\`.` };
      const account = parseAccount(service, await cli(service, accountArgs(service), git.root).catch(() => ""));
      const configured = (await cli(service, protocolArgs(), git.root).catch(() => "")).trim();
      return { service, ready: true, ...(account ? { account } : {}), protocol: configured === "ssh" ? "ssh" as const : "https" as const };
    }));
    return {
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.remote ? { remote: git.remote.name } : {}),
      folder: git.root.split(/[\\/]/u).filter(Boolean).at(-1) ?? "repository",
      services: answers,
    };
  });

  context.registerCommand("publish-repository", async (input): Promise<PublishResult> => {
    const fields = record(input);
    if (fields.confirm !== true) throw new HostCommandError("Publishing a repository needs your confirmation in the form.");
    const service = SERVICE_LIST.find((entry) => entry === fields.service);
    if (!service) throw new HostCommandError("Choose GitHub or GitLab.");
    const repository = typeof fields.repository === "string" ? fields.repository.trim() : "";
    if (!isRepositoryPath(repository)) throw new HostCommandError("Name the repository as owner/name, with letters, digits, dots, dashes and underscores.");
    const visibility: RepositoryVisibility = fields.visibility === "public" ? "public" : "private";
    const protocol: RemoteProtocol = fields.protocol === "ssh" ? "ssh" : "https";
    const git = await workspace<ReviewRequestContext>("review-request-context");
    if (git.remote) throw new HostCommandError(`This repository already has a remote (${git.remote.name}); it is published.`);
    if (!git.branch) throw new HostCommandError("Check out a branch before publishing; HEAD is detached.");
    const facts = SERVICES[service];
    if (!await cli(service, authArgs(), git.root).then(() => true, () => false)) {
      throw new HostCommandError(`${facts.label} is not signed in. Run \`${facts.login}\` in a terminal, then try again.`);
    }

    let created: CreatedRepository | undefined;
    try {
      created = service === "github"
        ? githubCreatedRepository(await cli(service, createRepositoryArgs(repository, visibility), git.root), repository)
        : await createGitlabProject(repository, visibility, (args) => cli(service, args, git.root));
    } catch (error) {
      throw new HostCommandError(`Creating the repository failed: ${message(error).split("\n")[0]}`);
    }
    if (!created) throw new HostCommandError(`${facts.label} created the repository but did not say where; add the remote by hand.`);
    services.log("repository.created", created.web);

    const remote = protocol === "ssh" ? created.ssh : created.https;
    let pushed = false;
    let step = "adding it as origin";
    try {
      const added = await workspace<{ hasCommits: boolean }>("add-remote", { name: "origin", url: remote });
      // A repository without a commit has nothing to push yet; the remote is enough.
      if (added.hasCommits) {
        step = "pushing to it";
        await workspace("push");
        pushed = true;
      }
    } catch (error) {
      throw new HostCommandError(`${created.web} was created, but ${step} failed: ${message(error).split("\n")[0]}`);
    }
    services.log(pushed ? "repository.pushed" : "repository.remote-added", remote);
    return { repository: created.nameWithOwner, url: created.web, remote, pushed, branch: git.branch };
  }, { long: true });
}

async function createGitlabProject(repository: string, visibility: RepositoryVisibility, glab: (args: string[]) => Promise<string>): Promise<CreatedRepository | undefined> {
  const at = repository.lastIndexOf("/");
  const namespace = at > 0 ? repository.slice(0, at) : undefined;
  const path = repository.slice(at + 1);
  let namespaceId: number | undefined;
  if (namespace) {
    const found = JSON.parse(await glab(gitlabNamespaceArgs(namespace))) as { id?: unknown };
    if (typeof found.id !== "number") throw new Error(`GitLab has no namespace ${namespace}.`);
    namespaceId = found.id;
  }
  return gitlabCreatedRepository(await glab(gitlabCreateProjectArgs(path, visibility, namespaceId)));
}
