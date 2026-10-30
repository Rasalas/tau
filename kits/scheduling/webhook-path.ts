export const MAX_WEBHOOK_PATH = 256;
export const WEBHOOK_PATH_PROBLEM = "Use names, numbers or [] separated by dots, such as issue.labels[].name.";

/** A suffix expands one array. No recursive descent, expressions or prototype access. */
export function validWebhookPath(path: unknown, wildcards = true): path is string {
  return typeof path === "string" && path.length <= MAX_WEBHOOK_PATH && path.split(".").length <= 16
    && /^[A-Za-z0-9_-]+(?:\[\])?(?:\.[A-Za-z0-9_-]+(?:\[\])?)*$/u.test(path)
    && (path.match(/\[\]/gu)?.length ?? 0) <= (wildcards ? 2 : 0);
}

export function webhookField(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, name)) return undefined;
  if (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/u.test(name)) return undefined;
  return (value as Record<string, unknown>)[name];
}

/** Key paths deliberately forbid fan-out. Values retain their JSON type. */
export function webhookKeyValue(payload: unknown, path: string): unknown {
  let value = payload;
  for (const segment of path.split(".")) value = webhookField(value, segment);
  return value;
}
