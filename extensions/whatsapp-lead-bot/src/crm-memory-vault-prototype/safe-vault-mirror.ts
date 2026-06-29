import path from "node:path";

export type FakeLeadForVaultMirror = {
  id: number;
  phoneNumber: string;
  name?: string | null;
  status?: string | null;
  city?: string | null;
  notes?: string | null;
  updatedAt?: number | string | null;
};

export type LeadVaultIdentity = {
  leadId: number;
  normalizedPhone: string;
  directoryName: string;
};

export type VaultMirrorFile = {
  relativePath: string;
  readOnly: true;
  content: string;
};

export type LeadVaultMirror = {
  leadDirectory: string;
  files: VaultMirrorFile[];
};

const LEAD_ROOT = "crm/leads";

export function normalizeTrustedLeadIdentity(lead: FakeLeadForVaultMirror): LeadVaultIdentity {
  if (!Number.isSafeInteger(lead.id) || lead.id <= 0) {
    throw new Error("Lead vault identity requires a positive integer lead id");
  }

  const normalizedPhone = lead.phoneNumber.replace(/\D/g, "");
  if (normalizedPhone.length < 8 || normalizedPhone.length > 15) {
    throw new Error("Lead vault identity requires a trusted phone number with 8-15 digits");
  }

  return {
    leadId: lead.id,
    normalizedPhone,
    directoryName: `lead-${lead.id.toString().padStart(8, "0")}-${normalizedPhone}`,
  };
}

export function assertSafeVaultRelativePath(relativePath: string): string {
  if (relativePath.length === 0 || path.posix.isAbsolute(relativePath)) {
    throw new Error("Vault mirror paths must be relative");
  }

  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Vault mirror paths cannot contain traversal segments");
  }

  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || !normalized.startsWith(`${LEAD_ROOT}/`)) {
    throw new Error("Vault mirror paths must stay under the generated lead root");
  }

  return relativePath;
}

export function leadVaultPathsFor(lead: FakeLeadForVaultMirror) {
  const identity = normalizeTrustedLeadIdentity(lead);
  const leadDirectory = assertSafeVaultRelativePath(
    path.posix.join(LEAD_ROOT, identity.directoryName),
  );

  return {
    identity,
    leadDirectory,
    leadMarkdownPath: assertSafeVaultRelativePath(path.posix.join(leadDirectory, "lead.md")),
    profileJsonPath: assertSafeVaultRelativePath(path.posix.join(leadDirectory, "profile.json")),
  };
}

export function renderReadOnlyLeadMirror(lead: FakeLeadForVaultMirror): LeadVaultMirror {
  const paths = leadVaultPathsFor(lead);
  const profile = {
    id: paths.identity.leadId,
    phoneNumber: paths.identity.normalizedPhone,
    name: lead.name ?? null,
    status: lead.status ?? "unknown",
    city: lead.city ?? null,
    updatedAt: lead.updatedAt ?? null,
    source: "fake-lead-object",
    readOnly: true,
  };

  return {
    leadDirectory: paths.leadDirectory,
    files: [
      {
        relativePath: paths.leadMarkdownPath,
        readOnly: true,
        content: renderLeadMarkdown(profile, lead.notes ?? null),
      },
      {
        relativePath: paths.profileJsonPath,
        readOnly: true,
        content: `${JSON.stringify(profile, null, 2)}\n`,
      },
    ],
  };
}

function renderLeadMarkdown(
  profile: {
    id: number;
    phoneNumber: string;
    name: string | null;
    status: string;
    city: string | null;
    updatedAt: number | string | null;
  },
  notes: string | null,
): string {
  const lines = [
    `# Lead ${profile.id}`,
    "",
    `- Phone: ${profile.phoneNumber}`,
    `- Name: ${profile.name ?? "Unknown"}`,
    `- Status: ${profile.status}`,
    `- City: ${profile.city ?? "Unknown"}`,
    `- Updated: ${profile.updatedAt ?? "Unknown"}`,
    "",
    "## Notes",
    notes ?? "No notes captured.",
    "",
  ];

  return lines.join("\n");
}
