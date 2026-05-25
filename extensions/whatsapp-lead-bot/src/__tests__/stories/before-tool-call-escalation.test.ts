import { describe, it, expect } from "vitest";
import {
  createBeforeToolCallHandler,
  type PricingEscalationContext,
} from "../../hooks/before-tool-call.js";
import { ViolationTracker } from "../../hooks/violation-tracker.js";
import type { PluginHookBeforeToolCallEvent } from "../../types.js";

const SESSION = "agent:solayre-leads:whatsapp:default:direct:526671000070";
const SESSION_OTHER = "agent:solayre-leads:whatsapp:default:direct:526671000071";

function priceMessage(text: string): PluginHookBeforeToolCallEvent {
  return {
    toolName: "message",
    params: { action: "send", target: "whatsapp:526671000070", message: text },
  };
}

function cleanMessage(text: string): PluginHookBeforeToolCallEvent {
  return {
    toolName: "message",
    params: { action: "send", target: "whatsapp:526671000070", message: text },
  };
}

describe("before_tool_call strike counter + escalation", () => {
  it("first pricing block → blocks with feedback, attempt 1", async () => {
    const violations = new ViolationTracker();
    const escalations: PricingEscalationContext[] = [];
    const handler = createBeforeToolCallHandler({
      violations,
      pricingStrikeThreshold: 2,
      onPricingEscalation: async (c) => {
        escalations.push(c);
      },
    });

    const result = await handler(priceMessage("le sale en $50,000"), { sessionKey: SESSION });

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("process_lead_cfe_receipt");
    expect(escalations).toHaveLength(0);
    expect(violations.count("526671000070")).toBe(1);
  });

  it("second pricing block in same session → escalates and resets", async () => {
    const violations = new ViolationTracker();
    const escalations: PricingEscalationContext[] = [];
    const handler = createBeforeToolCallHandler({
      violations,
      pricingStrikeThreshold: 2,
      onPricingEscalation: async (c) => {
        escalations.push(c);
      },
    });

    await handler(priceMessage("le sale en $50,000"), { sessionKey: SESSION });
    const result = await handler(priceMessage("a 12 meses sin intereses"), {
      sessionKey: SESSION,
    });

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("escalada a un asesor humano");
    expect(escalations).toHaveLength(1);
    expect(escalations[0].phone).toBe("526671000070");
    expect(escalations[0].attemptCount).toBe(2);
    expect(escalations[0].hit.pattern).toBe("financing_terms");
    expect(violations.count("526671000070")).toBe(0); // reset after escalation
  });

  it("clean message between two blocks resets the counter", async () => {
    const violations = new ViolationTracker();
    const escalations: PricingEscalationContext[] = [];
    const handler = createBeforeToolCallHandler({
      violations,
      pricingStrikeThreshold: 2,
      onPricingEscalation: async (c) => {
        escalations.push(c);
      },
    });

    await handler(priceMessage("$50,000"), { sessionKey: SESSION });
    expect(violations.count("526671000070")).toBe(1);

    await handler(cleanMessage("¿Con quién tengo el gusto?"), { sessionKey: SESSION });
    expect(violations.count("526671000070")).toBe(0);

    const second = await handler(priceMessage("$80,000"), { sessionKey: SESSION });
    expect(second?.block).toBe(true);
    expect(second?.blockReason).toContain("process_lead_cfe_receipt");
    expect(escalations).toHaveLength(0);
  });

  it("strike counts are independent across leads", async () => {
    const violations = new ViolationTracker();
    const handler = createBeforeToolCallHandler({
      violations,
      pricingStrikeThreshold: 2,
      onPricingEscalation: async () => {
        // noop
      },
    });

    await handler(priceMessage("$50,000"), { sessionKey: SESSION });
    await handler(priceMessage("$60,000"), { sessionKey: SESSION_OTHER });

    expect(violations.count("526671000070")).toBe(1);
    expect(violations.count("526671000071")).toBe(1);
  });

  it("escalation callback errors are swallowed and do not break the block response", async () => {
    const violations = new ViolationTracker();
    const handler = createBeforeToolCallHandler({
      violations,
      pricingStrikeThreshold: 2,
      onPricingEscalation: async () => {
        throw new Error("notif failed");
      },
    });

    await handler(priceMessage("$50,000"), { sessionKey: SESSION });
    const result = await handler(priceMessage("$60,000"), { sessionKey: SESSION });

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("escalada");
  });

  it("without violations dep, behaves like slice 1 (block, never escalate)", async () => {
    const handler = createBeforeToolCallHandler();
    const r1 = await handler(priceMessage("$50,000"), { sessionKey: SESSION });
    const r2 = await handler(priceMessage("$60,000"), { sessionKey: SESSION });
    const r3 = await handler(priceMessage("$70,000"), { sessionKey: SESSION });
    expect(r1?.block).toBe(true);
    expect(r2?.block).toBe(true);
    expect(r3?.block).toBe(true);
    expect(r1?.blockReason).not.toContain("escalada");
    expect(r3?.blockReason).not.toContain("escalada");
  });
});
