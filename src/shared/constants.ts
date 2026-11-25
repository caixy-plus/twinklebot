export const VALID_PROFILE_COLORS = new Set([
  "slate",
  "blue",
  "green",
  "amber",
  "rose",
  "purple",
  "teal",
]);

export const VALID_HOST_EXEC_MODES = new Set(["always", "ask", "off"]);

export const DEFAULT_POLICY = {
  autoAudit: true,
  askRules: [] as string[],
  allowRules: [] as string[],
};

export const DEFAULT_PRIVATE_SKILLS: Array<Record<string, any>> = [];
