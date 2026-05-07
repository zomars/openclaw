import { describe, it, expect } from "vitest";
import { allowedToolsForState, isToolAllowedInState } from "../../flow/allowed-tools.js";
import { buildStatePromptContext } from "../../flow/state-prompts.js";
import {
  computeLeadState,
  isOwner,
  isSinaloaLocation,
  leadStateInputFromRow,
  type LeadFieldsForState,
} from "../../flow/state.js";

function lead(overrides: Partial<LeadFieldsForState> = {}): LeadFieldsForState {
  return {
    status: "new",
    name: null,
    location: null,
    ownership: null,
    property_type: null,
    bimonthly_bill: null,
    bill_id: null,
    panels_quoted: null,
    ...overrides,
  };
}

describe("isSinaloaLocation", () => {
  it("matches Sinaloa municipalities (with and without accents)", () => {
    expect(isSinaloaLocation("Culiacán")).toBe(true);
    expect(isSinaloaLocation("culiacan")).toBe(true);
    expect(isSinaloaLocation("Mazatlán")).toBe(true);
    expect(isSinaloaLocation("Los Mochis")).toBe(true);
    expect(isSinaloaLocation("Sinaloa")).toBe(true);
  });

  it("rejects non-Sinaloa locations", () => {
    expect(isSinaloaLocation("Hermosillo")).toBe(false);
    expect(isSinaloaLocation("Ciudad de México")).toBe(false);
    expect(isSinaloaLocation("Tepic")).toBe(false);
  });
});

describe("isOwner", () => {
  it("recognizes owner variants", () => {
    expect(isOwner("propia")).toBe(true);
    expect(isOwner("propietario")).toBe(true);
    expect(isOwner("Dueño")).toBe(true);
  });
  it("rejects non-owner variants", () => {
    expect(isOwner("inquilino")).toBe(false);
    expect(isOwner("rentada")).toBe(false);
  });
});

describe("computeLeadState — terminals", () => {
  it("HANDED_OFF when status is handed_off", () => {
    expect(computeLeadState(lead({ status: "handed_off" }))).toBe("HANDED_OFF");
  });

  it("DISQUALIFIED when status is ignored or blocked", () => {
    expect(computeLeadState(lead({ status: "ignored" }))).toBe("DISQUALIFIED");
    expect(computeLeadState(lead({ status: "blocked" }))).toBe("DISQUALIFIED");
  });

  it("DISQUALIFIED when location is outside Sinaloa", () => {
    expect(computeLeadState(lead({ name: "Pedro", location: "Hermosillo" }))).toBe("DISQUALIFIED");
  });

  it("DISQUALIFIED when ownership indicates tenant", () => {
    expect(
      computeLeadState(lead({ name: "X", location: "Culiacán", ownership: "inquilino" })),
    ).toBe("DISQUALIFIED");
  });

  it("DISQUALIFIED when bimonthly_bill is below 500", () => {
    expect(
      computeLeadState(
        lead({
          name: "X",
          location: "Culiacán",
          ownership: "propia",
          property_type: "habitacional",
          bimonthly_bill: 300,
        }),
      ),
    ).toBe("DISQUALIFIED");
  });
});

describe("computeLeadState — linear progression", () => {
  it("NEW → AWAITING_NAME with bare phone-only lead", () => {
    expect(computeLeadState(lead())).toBe("AWAITING_NAME");
  });

  it("AWAITING_LOCATION when name is set", () => {
    expect(computeLeadState(lead({ name: "Pedro" }))).toBe("AWAITING_LOCATION");
  });

  it("AWAITING_OWNERSHIP when name + location", () => {
    expect(computeLeadState(lead({ name: "Pedro", location: "Culiacán" }))).toBe(
      "AWAITING_OWNERSHIP",
    );
  });

  it("AWAITING_PROPERTY_TYPE when name + location + ownership", () => {
    expect(computeLeadState(lead({ name: "X", location: "Culiacán", ownership: "propia" }))).toBe(
      "AWAITING_PROPERTY_TYPE",
    );
  });

  it("AWAITING_BILL_AMOUNT when qualifying fields filled but no bill", () => {
    expect(
      computeLeadState(
        lead({
          name: "X",
          location: "Culiacán",
          ownership: "propia",
          property_type: "habitacional",
        }),
      ),
    ).toBe("AWAITING_BILL_AMOUNT");
  });

  it("AWAITING_RECEIPT when bill amount reported but no parsed bill", () => {
    expect(
      computeLeadState(
        lead({
          name: "X",
          location: "Culiacán",
          ownership: "propia",
          property_type: "habitacional",
          bimonthly_bill: 2500,
        }),
      ),
    ).toBe("AWAITING_RECEIPT");
  });

  it("READY_TO_QUOTE when bill_id present", () => {
    expect(
      computeLeadState(
        lead({
          name: "X",
          location: "Culiacán",
          ownership: "propia",
          property_type: "habitacional",
          bimonthly_bill: 2500,
          bill_id: "uuid-123",
        }),
      ),
    ).toBe("READY_TO_QUOTE");
  });

  it("QUOTED when panels_quoted set", () => {
    expect(
      computeLeadState(
        lead({
          name: "X",
          location: "Culiacán",
          ownership: "propia",
          property_type: "habitacional",
          bimonthly_bill: 2500,
          bill_id: "uuid-123",
          panels_quoted: 12,
        }),
      ),
    ).toBe("QUOTED");
  });
});

describe("leadStateInputFromRow — extracts billId from receipt_data JSON", () => {
  it("extracts bill_id from JSON receipt_data", () => {
    const input = leadStateInputFromRow({
      status: "qualifying",
      name: "X",
      location: "Culiacán",
      ownership: "propia",
      property_type: "habitacional",
      bimonthly_bill: 2500,
      panels_quoted: null,
      receipt_data: JSON.stringify({ bill_id: "abc-123" }),
    });
    expect(input.bill_id).toBe("abc-123");
  });

  it("returns null bill_id when receipt_data is non-JSON", () => {
    const input = leadStateInputFromRow({
      status: "new",
      name: null,
      location: null,
      ownership: null,
      property_type: null,
      bimonthly_bill: null,
      panels_quoted: null,
      receipt_data: "garbage",
    });
    expect(input.bill_id).toBeNull();
  });

  it("returns null bill_id when receipt_data is null", () => {
    const input = leadStateInputFromRow({
      status: "new",
      name: null,
      location: null,
      ownership: null,
      property_type: null,
      bimonthly_bill: null,
      panels_quoted: null,
      receipt_data: null,
    });
    expect(input.bill_id).toBeNull();
  });
});

describe("allowed-tools tool gating", () => {
  it("process_cfe_receipt_customer is allowed once the receipt is in scope", () => {
    // Consolidated tool: parses the bill AND delivers the quote in one call.
    // Allowed in AWAITING_RECEIPT (when the customer sends the file) and in
    // READY_TO_QUOTE (re-quote without re-asking).
    expect(isToolAllowedInState("process_cfe_receipt_customer", "AWAITING_RECEIPT")).toBe(true);
    expect(isToolAllowedInState("process_cfe_receipt_customer", "READY_TO_QUOTE")).toBe(true);
    expect(isToolAllowedInState("process_cfe_receipt_customer", "AWAITING_NAME")).toBe(false);
    expect(isToolAllowedInState("process_cfe_receipt_customer", "QUOTED")).toBe(false);
  });

  it("edit_quote is only allowed in QUOTED", () => {
    expect(isToolAllowedInState("edit_quote", "QUOTED")).toBe(true);
    expect(isToolAllowedInState("edit_quote", "READY_TO_QUOTE")).toBe(false);
    expect(isToolAllowedInState("edit_quote", "AWAITING_RECEIPT")).toBe(false);
  });

  it("send_handoff_to_ale is only allowed in QUOTED", () => {
    expect(isToolAllowedInState("send_handoff_to_ale", "QUOTED")).toBe(true);
    expect(isToolAllowedInState("send_handoff_to_ale", "AWAITING_NAME")).toBe(false);
    expect(isToolAllowedInState("send_handoff_to_ale", "READY_TO_QUOTE")).toBe(false);
  });

  it("save_lead is allowed in all qualifying states", () => {
    for (const s of [
      "AWAITING_NAME",
      "AWAITING_LOCATION",
      "AWAITING_OWNERSHIP",
      "AWAITING_PROPERTY_TYPE",
      "AWAITING_BILL_AMOUNT",
      "AWAITING_RECEIPT",
    ] as const) {
      expect(isToolAllowedInState("save_lead", s)).toBe(true);
    }
  });

  it("send_disqualification is allowed during qualification, not after quoting", () => {
    expect(isToolAllowedInState("send_disqualification", "AWAITING_LOCATION")).toBe(true);
    expect(isToolAllowedInState("send_disqualification", "AWAITING_BILL_AMOUNT")).toBe(true);
    expect(isToolAllowedInState("send_disqualification", "READY_TO_QUOTE")).toBe(false);
    expect(isToolAllowedInState("send_disqualification", "QUOTED")).toBe(false);
  });

  it("DISQUALIFIED and HANDED_OFF allow no state-dependent tools", () => {
    expect(isToolAllowedInState("process_cfe_receipt_customer", "DISQUALIFIED")).toBe(false);
    expect(isToolAllowedInState("process_cfe_receipt_customer", "HANDED_OFF")).toBe(false);
    expect(isToolAllowedInState("message", "DISQUALIFIED")).toBe(false);
    expect(isToolAllowedInState("message", "HANDED_OFF")).toBe(false);
  });

  it("introspection tools are always allowed", () => {
    expect(isToolAllowedInState("get_lead", "DISQUALIFIED")).toBe(true);
    expect(isToolAllowedInState("get_lead", "HANDED_OFF")).toBe(true);
    expect(isToolAllowedInState("image", "AWAITING_RECEIPT")).toBe(true);
  });

  it("allowedToolsForState returns sorted list including always-allowed", () => {
    const allowed = allowedToolsForState("READY_TO_QUOTE");
    expect(allowed).toContain("process_cfe_receipt_customer");
    expect(allowed).toContain("get_lead");
    expect([...allowed]).toEqual([...allowed].toSorted());
  });
});

describe("buildStatePromptContext", () => {
  it("includes the state name in every prompt", () => {
    // Global rules live in the workspace system prompt (AGENTS.md / SOUL.md /
    // SALES.md), not in the per-turn injection. Tool gating is enforced by
    // the before-tool-call hook, not by repeating "PROHIBIDO" each turn.
    for (const state of [
      "NEW",
      "AWAITING_NAME",
      "AWAITING_LOCATION",
      "AWAITING_OWNERSHIP",
      "AWAITING_PROPERTY_TYPE",
      "AWAITING_BILL_AMOUNT",
      "AWAITING_RECEIPT",
      "READY_TO_QUOTE",
      "QUOTED",
      "DISQUALIFIED",
      "HANDED_OFF",
    ] as const) {
      const ctx = buildStatePromptContext(state);
      expect(ctx).toContain(`Estado: ${state}`);
    }
  });

  it("READY_TO_QUOTE prompt directs the LLM to invoke process_cfe_receipt_customer", () => {
    const ctx = buildStatePromptContext("READY_TO_QUOTE");
    expect(ctx).toContain("process_cfe_receipt_customer");
  });

  it("QUOTED prompt directs handoff for visit requests", () => {
    const ctx = buildStatePromptContext("QUOTED");
    expect(ctx).toContain("send_handoff_to_ale");
  });
});
