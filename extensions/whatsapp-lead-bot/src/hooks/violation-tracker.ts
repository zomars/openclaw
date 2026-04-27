/**
 * Tracks per-lead pricing-guardrail violations across a single LLM turn (and
 * the next) so the system can escalate to a human after repeated hallucinations.
 *
 * The tracker is intentionally simple: a counter per leadId. The counter is
 * incremented on each blocked attempt, reset to zero when a clean message
 * tool call passes through, and consulted to decide whether to escalate.
 *
 * No TTL — escalation belongs to the conversation, not the clock. A lead
 * who alucinates once and self-corrects gets a fresh slate; a lead who
 * fails twice in a row gets a human.
 */

export class ViolationTracker {
  private readonly counts = new Map<string, number>();

  increment(key: string): number {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  reset(key: string): void {
    this.counts.delete(key);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
