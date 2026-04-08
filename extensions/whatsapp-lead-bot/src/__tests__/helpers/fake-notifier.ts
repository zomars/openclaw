import type { CircuitBreakerNotifier } from "../../rate-limit/circuit-breaker.js";
import type { HandoffNotifier } from "../../handoff/manager.js";
import type { Lead } from "../../database/schema.js";

export class FakeNotifier implements CircuitBreakerNotifier, HandoffNotifier {
  tripped: string[] = [];
  resets = 0;
  handoffs: { lead: Lead; reason?: string; agentPhone?: string }[] = [];

  async notifyCircuitTripped(reason: string) {
    this.tripped.push(reason);
  }

  async notifyCircuitReset() {
    this.resets++;
  }

  async notifyHandoff(lead: Lead, reason?: string, agentPhone?: string) {
    this.handoffs.push({ lead, reason, agentPhone });
  }
}
