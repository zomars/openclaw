import { requireActiveWebListener } from "./active-listener.js";

export async function getLabelsWhatsApp(opts?: { accountId?: string }) {
  const { listener } = requireActiveWebListener(opts?.accountId);
  if (!listener.getLabels) {
    return [];
  }
  return await listener.getLabels();
}

export async function createLabelWhatsApp(
  name: string,
  color: number,
  opts?: { accountId?: string },
) {
  const { listener } = requireActiveWebListener(opts?.accountId);
  if (!listener.createLabel) {
    return undefined;
  }
  return await listener.createLabel(name, color);
}

export async function addChatLabelWhatsApp(
  chatJid: string,
  labelId: string,
  opts?: { accountId?: string },
) {
  const { listener } = requireActiveWebListener(opts?.accountId);
  await listener.addChatLabel(chatJid, labelId);
}

export async function addLabelWhatsApp(
  chatJid: string,
  label: { id: string; name?: string; color?: number; deleted?: boolean; predefinedId?: number },
  opts?: { accountId?: string },
) {
  const { listener } = requireActiveWebListener(opts?.accountId);
  if (!listener.addLabel) {
    await listener.addChatLabel(chatJid, label.id);
    return;
  }
  await listener.addLabel(chatJid, label);
}
