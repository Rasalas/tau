/** What the send menu can do with the draft: steer or queue while a turn runs, send at rest, or plan it. */
export type SendChoice = "steer" | "queue" | "send" | "plan";

/** The rows the send menu offers: the running turn's two deliveries, or a plain send, and Plan last. */
export function sendChoices(streaming: boolean, canPlan: boolean): SendChoice[] {
  return [...(streaming ? ["steer", "queue"] as const : ["send"] as const), ...(canPlan ? ["plan"] as const : [])];
}
