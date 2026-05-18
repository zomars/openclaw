import { describe, expect, it } from "vitest";
import { extractCoworkerPhones } from "../../config/coworker-whitelist.js";
import { OpenclawJsonWhitelistSource } from "../../config/coworker-whitelist/openclaw-json-whitelist.js";

const sampleConfig = {
  bindings: [
    {
      agentId: "default",
      match: { accountId: "default", channel: "telegram" },
    },
    {
      agentId: "solayre-coworker",
      match: {
        accountId: "solayre",
        channel: "whatsapp",
        peer: { id: "+5216672350818", kind: "direct" },
      },
    },
    {
      agentId: "solayre-coworker",
      match: {
        accountId: "solayre",
        channel: "whatsapp",
        peer: { id: "+5216672178748", kind: "direct" },
      },
    },
    {
      agentId: "solayre-leads",
      match: { accountId: "solayre", channel: "whatsapp" },
    },
    {
      agentId: "solayre-coworker",
      match: {
        accountId: "solayre",
        channel: "whatsapp",
        peer: { id: "120363427401851619@g.us", kind: "group" },
      },
    },
  ],
};

describe("extractCoworkerPhones", () => {
  it("returns direct peers bound to the given agent in canonical form", () => {
    const phones = extractCoworkerPhones(sampleConfig, {
      agentId: "solayre-coworker",
    });
    expect(phones.toSorted()).toEqual(["526672178748", "526672350818"]);
  });

  it("filters by channel when provided", () => {
    const phones = extractCoworkerPhones(sampleConfig, {
      agentId: "solayre-coworker",
      channel: "telegram",
    });
    expect(phones).toEqual([]);
  });

  it("skips non-direct peers (groups, broadcasts)", () => {
    const phones = extractCoworkerPhones(sampleConfig, {
      agentId: "solayre-coworker",
    });
    expect(phones).not.toContain("120363427401851619@g.us");
  });

  it("returns an empty array when bindings are missing or malformed", () => {
    expect(extractCoworkerPhones({}, { agentId: "x" })).toEqual([]);
    expect(extractCoworkerPhones(null, { agentId: "x" })).toEqual([]);
    expect(extractCoworkerPhones({ bindings: "nope" }, { agentId: "x" })).toEqual([]);
  });

  it("deduplicates identical phones across multiple bindings", () => {
    const config = {
      bindings: [
        {
          agentId: "a",
          match: { peer: { id: "+5216672350818", kind: "direct" } },
        },
        {
          agentId: "a",
          match: { peer: { id: "5216672350818", kind: "direct" } },
        },
      ],
    };
    expect(extractCoworkerPhones(config, { agentId: "a" })).toEqual(["526672350818"]);
  });
});

describe("OpenclawJsonWhitelistSource", () => {
  it("loads + caches the canonical phone set", async () => {
    let reads = 0;
    const source = new OpenclawJsonWhitelistSource({
      configPath: "/fake/openclaw.json",
      agentId: "solayre-coworker",
      readFile: async () => {
        reads++;
        return JSON.stringify(sampleConfig);
      },
    });

    const first = await source.load();
    const second = await source.load();
    expect([...first].toSorted()).toEqual(["526672178748", "526672350818"]);
    expect(second).toBe(first);
    expect(reads).toBe(1);
  });

  it("re-reads after invalidate()", async () => {
    let reads = 0;
    const source = new OpenclawJsonWhitelistSource({
      configPath: "/fake/openclaw.json",
      agentId: "solayre-coworker",
      readFile: async () => {
        reads++;
        return JSON.stringify(sampleConfig);
      },
    });

    await source.load();
    source.invalidate();
    await source.load();
    expect(reads).toBe(2);
  });
});
