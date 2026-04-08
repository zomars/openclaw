import type { Runtime } from "../../runtime.js";

export interface FakeRuntime extends Runtime {
  sentMessages: { to: string; content: { text: string; metadata?: Record<string, unknown> } }[];
  addedLabels: { jid: string; id: string }[];
  removedLabels: { jid: string; id: string }[];
  createLabelCalls: { name: string; color: number }[];
}

export function createFakeRuntime(): FakeRuntime {
  const sentMessages: FakeRuntime["sentMessages"] = [];
  const addedLabels: FakeRuntime["addedLabels"] = [];
  const removedLabels: FakeRuntime["removedLabels"] = [];
  const createLabelCalls: FakeRuntime["createLabelCalls"] = [];

  return {
    sentMessages,
    addedLabels,
    removedLabels,
    createLabelCalls,
    async sendMessage(to, content) {
      sentMessages.push({ to, content });
    },
    async addChatLabel(jid: string, id: string) {
      addedLabels.push({ jid, id });
    },
    async removeChatLabel(jid: string, id: string) {
      removedLabels.push({ jid, id });
    },
    async getLabels() {
      return [];
    },
    async createLabel(name: string, color: number) {
      createLabelCalls.push({ name, color });
      return undefined;
    },
  };
}
