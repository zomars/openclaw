export type CrmMemoryRolloutFlags = {
  enabled: boolean;
  mirrorEnabled: boolean;
  eventWritesEnabled: boolean;
  contextReadsEnabled: boolean;
  cronGateEnabled: boolean;
  adminStatusEnabled: boolean;
};

export const DEFAULT_CRM_MEMORY_ROLLOUT_FLAGS: CrmMemoryRolloutFlags = {
  enabled: false,
  mirrorEnabled: false,
  eventWritesEnabled: false,
  contextReadsEnabled: false,
  cronGateEnabled: false,
  adminStatusEnabled: false,
};

export function resolveCrmMemoryRolloutFlags(
  input: Partial<CrmMemoryRolloutFlags> | undefined,
): CrmMemoryRolloutFlags {
  const flags = {
    ...DEFAULT_CRM_MEMORY_ROLLOUT_FLAGS,
    ...input,
  };

  if (!flags.enabled) {
    return {
      ...flags,
      mirrorEnabled: false,
      eventWritesEnabled: false,
      contextReadsEnabled: false,
      cronGateEnabled: false,
      adminStatusEnabled: false,
    };
  }

  return flags;
}
