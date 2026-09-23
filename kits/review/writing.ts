/** Review Kit's options for the text it writes: the user's own instructions and the request template. */
export const INSTRUCTIONS_OPTION = "writing-instructions";
export const TEMPLATE_OPTION = "follow-request-template";

/** The user's own words about commit and request text, after the kit's; capped so a paste cannot crowd out the diff. */
export function withInstructions(system: string, instructions: unknown): string {
  const text = typeof instructions === "string" ? instructions.trim().slice(0, 2_000) : "";
  return text ? `${system}\n\nThe user's own instructions follow; where they differ from the above, they win:\n${text}` : system;
}
