import { describe, expect, it } from "vitest";
import { translateErrorToSpanish } from "./message-sending.js";

const SPANISH_GENERIC = "Permitenos un momento. Te atenderemos tan pronto nos sea posible.";
const SPANISH_BILLING =
  "El servicio no esta disponible temporalmente. Por favor intente mas tarde.";

describe("translateErrorToSpanish", () => {
  it("translates the exact upstream rate-limit message", () => {
    expect(
      translateErrorToSpanish("\u26a0\ufe0f API rate limit reached. Please try again later."),
    ).toBe(SPANISH_GENERIC);
  });

  it("translates the exact upstream overloaded message", () => {
    expect(
      translateErrorToSpanish(
        "The AI service is temporarily overloaded. Please try again in a moment.",
      ),
    ).toBe(SPANISH_GENERIC);
  });

  it("preserves provider-specific rate-limit hints (actionable detail)", () => {
    expect(
      translateErrorToSpanish("\u26a0\ufe0f Rate limit exceeded. Try again in 30 seconds."),
    ).toBeUndefined();
  });

  it("preserves provider-specific quota info", () => {
    expect(
      translateErrorToSpanish("\u26a0\ufe0f You have exceeded your plan quota. Upgrade your plan."),
    ).toBeUndefined();
  });

  it("translates fuzzy rate-limit errors with warning prefix", () => {
    expect(translateErrorToSpanish("\u26a0\ufe0f Rate limit hit for this model.")).toBe(
      SPANISH_GENERIC,
    );
  });

  it("translates fuzzy overloaded errors", () => {
    expect(translateErrorToSpanish("Service is overloaded, please wait.")).toBe(SPANISH_GENERIC);
  });

  it("translates billing errors", () => {
    expect(
      translateErrorToSpanish(
        "\u26a0\ufe0f API provider returned a billing error \u2014 your API key has run out of credits or has an insufficient balance.",
      ),
    ).toBe(SPANISH_BILLING);
  });

  it("returns undefined for normal agent messages", () => {
    expect(
      translateErrorToSpanish("Hola, gracias por contactarnos. En que podemos ayudarte?"),
    ).toBeUndefined();
  });

  it("returns undefined for empty content", () => {
    expect(translateErrorToSpanish("")).toBeUndefined();
  });

  it("returns undefined for transport/disk errors (operator-facing)", () => {
    expect(
      translateErrorToSpanish("LLM request failed: connection refused by the provider endpoint."),
    ).toBeUndefined();
  });
});
