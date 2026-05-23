import { describe, expect, it, vi } from "vitest";
import { loadMergedBundleMcpConfig, toCliBundleMcpServerConfig } from "./bundle-mcp-config.js";

const mocks = vi.hoisted(() => ({
  bundleMcp: {
    config: {
      mcpServers: {
        bundleProbe: {
          command: "node",
          args: ["./servers/probe.mjs"],
        },
      },
    },
    diagnostics: [],
  },
}));

vi.mock("../plugins/bundle-mcp.js", () => ({
  loadEnabledBundleMcpConfig: () => mocks.bundleMcp,
}));

describe("loadMergedBundleMcpConfig", () => {
  it("lets OpenClaw mcp.servers override bundle defaults while preserving raw transport shape", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
        mcp: {
          servers: {
            bundleProbe: {
              transport: "streamable-http",
              url: "https://mcp.example.com/mcp",
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers.bundleProbe).toEqual({
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("filters configured MCP servers by allowAgents", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      agentId: "default",
      cfg: {
        mcp: {
          servers: {
            flightconnections: {
              command: "node",
              args: ["./server.mjs"],
              allowAgents: ["default"],
            },
            other: {
              command: "node",
              args: ["./other.mjs"],
              allowAgents: ["hank"],
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers.flightconnections).toEqual({
      command: "node",
      args: ["./server.mjs"],
    });
    expect(merged.config.mcpServers.other).toBeUndefined();
  });

  it("filters configured MCP servers by denyAgents", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      agentId: "hank",
      cfg: {
        mcp: {
          servers: {
            flightconnections: {
              command: "node",
              args: ["./server.mjs"],
              denyAgents: ["hank"],
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers.flightconnections).toBeUndefined();
  });

  it("maps OpenClaw transports to downstream CLI types when requested", () => {
    expect(
      toCliBundleMcpServerConfig({
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
      }),
    ).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
    expect(toCliBundleMcpServerConfig({ type: "sse", transport: "streamable-http" })).toEqual({
      type: "sse",
    });
  });
});
