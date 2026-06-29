import { assertSafeMirrorRelativePath } from "./lead-mirror.js";
import type { TrustedWhatsAppLeadScope } from "./lead-scope.js";

export type LeadArtifactDraft = {
  type: "cfe_receipt" | "quote" | "audio" | "image";
  pointer: string;
  checksum?: string;
  source: {
    channel: "whatsapp" | string;
    messageId?: string;
    toolName?: string;
  };
};

export type LeadArtifactRecord = LeadArtifactDraft & {
  id: string;
  leadKey: string;
  leadPhone: string;
  relativePath: string;
};

export function registerLeadArtifact(input: {
  scope: TrustedWhatsAppLeadScope;
  artifact: LeadArtifactDraft;
  now?: () => number;
}): LeadArtifactRecord {
  if (!input.scope.ok) {
    throw new Error(`Cannot register lead artifact without trusted scope: ${input.scope.reason}`);
  }

  const timestamp = input.now?.() ?? Date.now();
  const id = `artifact-${timestamp}-${input.artifact.type}`;
  const relativePath = assertSafeMirrorRelativePath(
    `crm/leads/${input.scope.scope.leadKey.replace(":", "-")}/artifacts/${id}.json`,
  );

  return {
    ...input.artifact,
    id,
    leadKey: input.scope.scope.leadKey,
    leadPhone: input.scope.scope.leadPhone,
    relativePath,
  };
}
