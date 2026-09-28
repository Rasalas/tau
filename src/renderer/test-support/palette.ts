import { fireEvent, screen, waitFor, within } from "@testing-library/react";

/** Opens the command palette with its chord; answers its field once the palette is ready for typing. */
export async function openCommandPalette(): Promise<HTMLInputElement> {
  const mac = /mac|iphone|ipad/iu.test(navigator.platform);
  fireEvent.keyDown(window, { key: "k", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  const input = within(palette).getByRole("textbox", { name: "Command" }) as HTMLInputElement;
  // The palette clears its field in the effect that focuses it. On the first opening its chunk
  // loads, the dialog can be found before that effect runs, and it would erase what was typed.
  await waitFor(() => {
    if (document.activeElement !== input) throw new Error("The command palette has not focused its field yet.");
  });
  return input;
}

/** Types a command's label into the palette, runs the first row, and waits for the palette to close. */
export async function runPaletteCommand(label: string): Promise<void> {
  const input = await openCommandPalette();
  fireEvent.change(input, { target: { value: label } });
  fireEvent.keyDown(input, { key: "Enter", bubbles: true, cancelable: true });
  await waitFor(() => {
    if (screen.queryByRole("dialog", { name: "Command palette" })) throw new Error("The command palette is still open.");
  });
}
