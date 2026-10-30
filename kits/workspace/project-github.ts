/**
 * "Create a GitHub repository" in the New project form. Review Kit publishes
 * it (`publish-repository`); this module only names what to ask for, so the
 * form and the host agree on the repository before anything exists.
 */
export type RepositoryVisibility = "private" | "public";

/** What the form sends with `create-project`: no owner means the account `gh` is signed in as. */
export interface NewProjectGithub {
  owner?: string;
  visibility: RepositoryVisibility;
}

/** What GitHub answered: the repository, its page, and whether the first commit reached it. */
export interface NewProjectRepository {
  repository: string;
  url: string;
  pushed: boolean;
  branch?: string;
}

/** A GitHub user or organization name: letters, digits and single inner dashes. */
export const isGithubOwner = (value: string): boolean => /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(value);

/** The repository name GitHub would make of a project name: spaces and symbols become dashes. */
export function githubRepositoryName(project: string): string {
  return project.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100);
}

/** `owner/name`, or just `name` for the signed-in account; undefined when the project name has nothing GitHub accepts. */
export function githubRepositoryPath(project: string, owner?: string): string | undefined {
  const name = githubRepositoryName(project);
  if (!name || name === "." || name === "..") return undefined;
  const who = owner?.trim();
  return who ? `${who}/${name}` : name;
}

/** The form's choice as the host receives it; undefined when the box was not ticked. */
export function readNewProjectGithub(value: unknown): NewProjectGithub | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Describe the GitHub repository as { owner?, visibility }.");
  const fields = value as Record<string, unknown>;
  const owner = typeof fields.owner === "string" ? fields.owner.trim() : "";
  if (owner && !isGithubOwner(owner)) throw new Error(`"${owner}" is not a GitHub user or organization name.`);
  return { ...(owner ? { owner } : {}), visibility: fields.visibility === "public" ? "public" : "private" };
}
