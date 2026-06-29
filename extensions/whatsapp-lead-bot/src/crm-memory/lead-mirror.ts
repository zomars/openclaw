import path from "node:path";
import type { Lead } from "../database/schema.js";
import { normalizePhone } from "../utils/phone.js";

export type LeadMirrorIdentity = {
  leadId: number;
  normalizedPhone: string;
  directoryName: string;
};

export type LeadMirrorFile = {
  relativePath: string;
  readOnly: true;
  content: string;
};

export type ReadOnlyLeadMirror = {
  leadDirectory: string;
  files: LeadMirrorFile[];
};

const LEAD_ROOT = "crm/leads";

export function renderReadOnlyLeadMirror(lead: Lead): ReadOnlyLeadMirror {
  const paths = leadMirrorPathsFor(lead);
  const profile = buildLeadProfile(lead, paths.identity.normalizedPhone);

  return {
    leadDirectory: paths.leadDirectory,
    files: [
      {
        relativePath: paths.leadMarkdownPath,
        readOnly: true,
        content: renderLeadMarkdown(profile, lead.notes),
      },
      {
        relativePath: paths.profileJsonPath,
        readOnly: true,
        content: `${JSON.stringify(profile, null, 2)}\n`,
      },
    ],
  };
}

export function leadMirrorPathsFor(lead: Pick<Lead, "id" | "phone_number">) {
  const identity = normalizeLeadMirrorIdentity(lead);
  const leadDirectory = assertSafeMirrorRelativePath(
    path.posix.join(LEAD_ROOT, identity.directoryName),
  );

  return {
    identity,
    leadDirectory,
    leadMarkdownPath: assertSafeMirrorRelativePath(path.posix.join(leadDirectory, "lead.md")),
    profileJsonPath: assertSafeMirrorRelativePath(path.posix.join(leadDirectory, "profile.json")),
  };
}

export function normalizeLeadMirrorIdentity(
  lead: Pick<Lead, "id" | "phone_number">,
): LeadMirrorIdentity {
  if (!Number.isSafeInteger(lead.id) || lead.id <= 0) {
    throw new Error("Lead mirror identity requires a positive integer lead id");
  }

  const normalizedPhone = normalizePhone(lead.phone_number);
  if (!normalizedPhone || normalizedPhone.length < 8 || normalizedPhone.length > 15) {
    throw new Error("Lead mirror identity requires a trusted phone number with 8-15 digits");
  }

  return {
    leadId: lead.id,
    normalizedPhone,
    directoryName: `lead-${lead.id.toString().padStart(8, "0")}-${normalizedPhone}`,
  };
}

export function assertSafeMirrorRelativePath(relativePath: string): string {
  if (relativePath.length === 0 || path.posix.isAbsolute(relativePath)) {
    throw new Error("Lead mirror paths must be relative");
  }

  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Lead mirror paths cannot contain traversal segments");
  }

  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || !normalized.startsWith(`${LEAD_ROOT}/`)) {
    throw new Error("Lead mirror paths must stay under the generated lead root");
  }

  return relativePath;
}

function buildLeadProfile(lead: Lead, normalizedPhone: string) {
  return {
    id: lead.id,
    phoneNumber: normalizedPhone,
    name: lead.name,
    status: lead.status,
    score: lead.score,
    location: lead.location,
    propertyType: lead.property_type,
    ownership: lead.ownership,
    bimonthlyBill: lead.bimonthly_bill,
    panelsQuoted: lead.panels_quoted,
    quoteCash: lead.quote_cash,
    quoteFinanced: lead.quote_financed,
    quotedAt: lead.quoted_at,
    tariff: lead.tariff,
    annualKwh: lead.annual_kwh,
    timestamps: {
      firstContactAt: lead.first_contact_at,
      lastMessageAt: lead.last_message_at,
      lastBotReplyAt: lead.last_bot_reply_at,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
    },
    handoff: {
      assignedAgent: lead.assigned_agent,
      handedOffAt: lead.handed_off_at,
    },
    source: {
      type: "leads.db",
      leadId: lead.id,
      sourceUpdatedAt: lead.updated_at,
      readOnly: true,
    },
  };
}

function renderLeadMarkdown(
  profile: ReturnType<typeof buildLeadProfile>,
  notes: string | null,
): string {
  const lines = [
    `# Lead ${profile.id}`,
    "",
    `- Phone: ${profile.phoneNumber}`,
    `- Name: ${profile.name ?? "Unknown"}`,
    `- Status: ${profile.status}`,
    `- Score: ${profile.score ?? "Unknown"}`,
    `- Location: ${profile.location ?? "Unknown"}`,
    `- Property type: ${profile.propertyType ?? "Unknown"}`,
    `- Ownership: ${profile.ownership ?? "Unknown"}`,
    `- Bimonthly bill: ${profile.bimonthlyBill ?? "Unknown"}`,
    `- Panels quoted: ${profile.panelsQuoted ?? "Unknown"}`,
    `- Quote cash: ${profile.quoteCash ?? "Unknown"}`,
    `- Updated: ${profile.timestamps.updatedAt}`,
    "",
    "## Notes",
    notes ?? "No notes captured.",
    "",
    "## Source",
    `- type: ${profile.source.type}`,
    `- readOnly: ${profile.source.readOnly}`,
    `- sourceUpdatedAt: ${profile.source.sourceUpdatedAt}`,
    "",
  ];

  return lines.join("\n");
}
