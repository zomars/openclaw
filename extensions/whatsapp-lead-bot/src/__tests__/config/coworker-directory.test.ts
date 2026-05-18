import { describe, expect, it, vi } from "vitest";
import {
  CompositeCoworkerDirectory,
  NoopNameResolver,
  type CoworkerWhitelistSource,
  type NameResolver,
} from "../../config/coworker-directory.js";
import { MacOSContactsResolver } from "../../config/coworker-directory/macos-contacts-resolver.js";

class StubWhitelist implements CoworkerWhitelistSource {
  constructor(private readonly phones: string[]) {}
  async load(): Promise<Set<string>> {
    return new Set(this.phones);
  }
}

describe("CompositeCoworkerDirectory", () => {
  it("zips whitelist phones with resolver names", async () => {
    const directory = new CompositeCoworkerDirectory({
      whitelist: new StubWhitelist(["526672350818", "526672178748", "526677550044"]),
      resolver: {
        resolveBatch: async (phones) => {
          const map = new Map<string, string>();
          for (const p of phones) {
            if (p === "526672350818") {
              map.set(p, "zomars");
            }
            if (p === "526672178748") {
              map.set(p, "Aleyda");
            }
            // 550044 intentionally not resolved
          }
          return map;
        },
      },
    });

    const entries = await directory.list();
    expect(entries.toSorted((a, b) => a.phone.localeCompare(b.phone))).toEqual([
      { phone: "526672178748", name: "Aleyda" },
      { phone: "526672350818", name: "zomars" },
      { phone: "526677550044", name: null },
    ]);
  });

  it("caches list() across calls until invalidate()", async () => {
    let resolverCalls = 0;
    const resolver: NameResolver = {
      resolveBatch: async () => {
        resolverCalls++;
        return new Map();
      },
    };
    const directory = new CompositeCoworkerDirectory({
      whitelist: new StubWhitelist(["526672350818"]),
      resolver,
    });

    await directory.list();
    await directory.list();
    expect(resolverCalls).toBe(1);

    directory.invalidate();
    await directory.list();
    expect(resolverCalls).toBe(2);
  });

  it("returns phones with null names when the resolver is a no-op", async () => {
    const directory = new CompositeCoworkerDirectory({
      whitelist: new StubWhitelist(["526672350818"]),
      resolver: new NoopNameResolver(),
    });
    expect(await directory.list()).toEqual([{ phone: "526672350818", name: null }]);
  });
});

describe("MacOSContactsResolver", () => {
  it("parses JXA stdout into a phone→name map", async () => {
    const fakeRunJxa = vi.fn(async () =>
      JSON.stringify({
        "526672350818": "zomars",
        "526672178748": "Aleyda Bo",
        "526677550044": "  ", // whitespace only → dropped
      }),
    );

    const resolver = new MacOSContactsResolver({ runJxa: fakeRunJxa });
    const result = await resolver.resolveBatch([
      "+5216672350818",
      "5216672178748",
      "+5216677550044",
    ]);

    expect(result.get("526672350818")).toBe("zomars");
    expect(result.get("526672178748")).toBe("Aleyda Bo");
    expect(result.has("526677550044")).toBe(false);
  });

  it("returns an empty map when the JXA call fails", async () => {
    const resolver = new MacOSContactsResolver({
      runJxa: async () => {
        throw new Error("Contacts not authorized");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await resolver.resolveBatch(["526672350818"]);
    expect(result.size).toBe(0);
    warn.mockRestore();
  });

  it("deduplicates inputs and skips empty phones before invoking JXA", async () => {
    let scriptSeen = "";
    const resolver = new MacOSContactsResolver({
      runJxa: async (script) => {
        scriptSeen = script;
        return "{}";
      },
    });
    await resolver.resolveBatch(["+5216672350818", "5216672350818", ""]);
    // Script should contain the canonical phone once
    expect(scriptSeen.match(/526672350818/g)?.length).toBe(1);
  });
});
