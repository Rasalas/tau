// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { AddModelProviderModal } from "./AddModelProviderModal";

afterEach(cleanup);

describe("AddModelProviderModal", () => {
  it("renders form fields and validates inputs", async () => {
    const onClose = vi.fn();
    render(
      <HostClientProvider client={createFakeHostClient()}>
        <AddModelProviderModal onClose={onClose} />
      </HostClientProvider>,
    );

    expect(screen.getByRole("dialog", { name: "Add Model Provider" })).toBeDefined();
    expect(screen.getByPlaceholderText(/ollama, openrouter/i)).toBeDefined();
    expect(screen.getByPlaceholderText(/llama3, mistral/i)).toBeDefined();

    const saveButton = screen.getByRole("button", { name: /save provider/i });
    fireEvent.click(saveButton);

    // Form inputs have 'required' attributes so HTML5 validation prevents submit with empty required fields
    expect(onClose).not.toHaveBeenCalled();
  });

  it("submits valid provider config to hostClient and triggers callbacks", async () => {
    const onClose = vi.fn();
    const onProviderAdded = vi.fn();
    const addModelProvider = vi.fn().mockResolvedValue([
      { provider: "ollama-local", id: "llama3", name: "Llama 3" },
    ]);

    const fakeClient = createFakeHostClient({ addModelProvider });

    render(
      <HostClientProvider client={fakeClient}>
        <AddModelProviderModal onClose={onClose} onProviderAdded={onProviderAdded} />
      </HostClientProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText(/ollama, openrouter/i), {
      target: { value: "ollama-local" },
    });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Ollama Local/i), {
      target: { value: "Ollama Local" },
    });
    fireEvent.change(screen.getByPlaceholderText(/http:\/\/localhost:11434\/v1/i), {
      target: { value: "http://localhost:11434/v1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/llama3, mistral/i), {
      target: { value: "llama3" },
    });
    fireEvent.change(screen.getByPlaceholderText(/128000/i), {
      target: { value: "32768" },
    });

    const form = screen.getByRole("dialog", { name: "Add Model Provider" }).querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(addModelProvider).toHaveBeenCalledWith({
        providerId: "ollama-local",
        name: "Ollama Local",
        baseUrl: "http://localhost:11434/v1",
        api: "openai-compatible",
        apiKey: undefined,
        models: [
          {
            id: "llama3",
            name: "llama3",
            contextWindow: 32768,
          },
        ],
      });
      expect(onProviderAdded).toHaveBeenCalledWith([
        { provider: "ollama-local", id: "llama3", name: "Llama 3" },
      ]);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("closes when cancel button is clicked", () => {
    const onClose = vi.fn();
    render(
      <HostClientProvider client={createFakeHostClient()}>
        <AddModelProviderModal onClose={onClose} />
      </HostClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
