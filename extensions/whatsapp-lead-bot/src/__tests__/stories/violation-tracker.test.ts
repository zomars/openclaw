import { describe, it, expect } from "vitest";
import { ViolationTracker } from "../../hooks/violation-tracker.js";

describe("ViolationTracker", () => {
  it("starts at zero, increments per call", () => {
    const t = new ViolationTracker();
    expect(t.count("a")).toBe(0);
    expect(t.increment("a")).toBe(1);
    expect(t.increment("a")).toBe(2);
    expect(t.increment("a")).toBe(3);
    expect(t.count("a")).toBe(3);
  });

  it("counts are independent per key", () => {
    const t = new ViolationTracker();
    t.increment("a");
    t.increment("a");
    t.increment("b");
    expect(t.count("a")).toBe(2);
    expect(t.count("b")).toBe(1);
  });

  it("reset clears the count for a key without affecting others", () => {
    const t = new ViolationTracker();
    t.increment("a");
    t.increment("b");
    t.reset("a");
    expect(t.count("a")).toBe(0);
    expect(t.count("b")).toBe(1);
  });

  it("incrementing after reset starts fresh from 1", () => {
    const t = new ViolationTracker();
    t.increment("a");
    t.increment("a");
    t.reset("a");
    expect(t.increment("a")).toBe(1);
  });
});
