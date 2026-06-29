import type { LeadContext } from "./lead-context.js";

export function renderAdminLeadStatus(input: {
  trustedAdmin: boolean;
  context: LeadContext;
}): string {
  if (!input.trustedAdmin) {
    throw new Error("Admin lead status requires a trusted admin sender");
  }

  const { snapshot } = input.context;
  const lines = [
    "**CRM Lead Status**",
    "",
    `Phone: ${input.context.leadPhone}`,
    `Name: ${snapshot.profile.name.value ?? "N/A"}`,
    `Status: ${snapshot.profile.status.value}`,
    `Score: ${snapshot.profile.score.value ?? "N/A"}`,
    `Location: ${snapshot.profile.location.value ?? "N/A"}`,
    `Bill: ${snapshot.profile.bimonthlyBill.value ?? "N/A"}`,
    `Intent: ${snapshot.profile.intent?.value ?? "N/A"}`,
    "",
    `Human handoff: ${snapshot.locks.humanHandoff.active ? "active" : "inactive"}`,
    `Artifacts: ${snapshot.artifacts.length}`,
    `Timeline events: ${snapshot.timeline.length}`,
    `Conflicts: ${snapshot.conflicts.length}`,
    `Next: ${input.context.nextActionHints.join(", ")}`,
  ];

  if (snapshot.conflicts.length > 0) {
    lines.push("", "Conflicts:");
    for (const conflict of snapshot.conflicts.slice(0, 3)) {
      lines.push(
        `- ${conflict.field}: ${String(conflict.current)} vs ${String(conflict.incoming)}`,
      );
    }
  }

  return lines.join("\n");
}
