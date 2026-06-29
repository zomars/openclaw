import { describe, expect, it } from "vitest";
import {
  assertSafeVaultRelativePath,
  leadVaultPathsFor,
  renderReadOnlyLeadMirror,
} from "../../crm-memory-vault-prototype/safe-vault-mirror.js";

describe("CRM memory vault path and mirror prototype", () => {
  it("creates lead directories from trusted normalized identity, not user text", () => {
    const lead = {
      id: 42,
      phoneNumber: "+52 (166) 710-0000",
      name: "../../otra-persona",
      status: "qualified",
      city: "Culiacan",
      notes: "User text may mention ../other-lead/profile.json but cannot affect the path.",
      updatedAt: "2026-06-24T12:00:00.000Z",
    };

    const paths = leadVaultPathsFor(lead);

    expect(paths.identity).toEqual({
      leadId: 42,
      normalizedPhone: "521667100000",
      directoryName: "lead-00000042-521667100000",
    });
    expect(paths.leadDirectory).toBe("crm/leads/lead-00000042-521667100000");
    expect(paths.leadMarkdownPath).toBe("crm/leads/lead-00000042-521667100000/lead.md");
    expect(paths.profileJsonPath).toBe("crm/leads/lead-00000042-521667100000/profile.json");
    expect(paths.leadDirectory).not.toContain("otra-persona");
    expect(paths.leadDirectory).not.toContain("..");
  });

  it("blocks traversal and absolute vault paths", () => {
    expect(() => assertSafeVaultRelativePath("../crm/leads/lead-1/lead.md")).toThrow(/traversal/);
    expect(() => assertSafeVaultRelativePath("crm/leads/lead-1/../../lead-2/profile.json")).toThrow(
      /traversal/,
    );
    expect(() => assertSafeVaultRelativePath("/crm/leads/lead-1/lead.md")).toThrow(/relative/);
    expect(() => assertSafeVaultRelativePath("lead-1/profile.json")).toThrow(/generated lead root/);
  });

  it("renders a minimal read-only lead.md and profile.json payload in memory", () => {
    const mirror = renderReadOnlyLeadMirror({
      id: 7,
      phoneNumber: "667-200-3000",
      name: "Ana Prospecto",
      status: "new",
      city: "Mazatlan",
      notes: "Asked for a residential solar quote.",
      updatedAt: 1782312000000,
    });

    expect(mirror.leadDirectory).toBe("crm/leads/lead-00000007-6672003000");
    expect(mirror.files).toHaveLength(2);
    expect(mirror.files.map((file) => file.relativePath)).toEqual([
      "crm/leads/lead-00000007-6672003000/lead.md",
      "crm/leads/lead-00000007-6672003000/profile.json",
    ]);
    expect(mirror.files.every((file) => file.readOnly)).toBe(true);
    expect(mirror.files[0]?.content).toContain("# Lead 7");
    expect(mirror.files[0]?.content).toContain("Asked for a residential solar quote.");
    expect(JSON.parse(mirror.files[1]?.content ?? "{}")).toEqual({
      id: 7,
      phoneNumber: "6672003000",
      name: "Ana Prospecto",
      status: "new",
      city: "Mazatlan",
      updatedAt: 1782312000000,
      source: "fake-lead-object",
      readOnly: true,
    });
  });
});
