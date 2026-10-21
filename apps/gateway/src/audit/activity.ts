import type { AuditOutcome } from "./logger.js";

export type Activity = "attempts" | "failures" | "durations";
// Aggregation and linked history must select the same recorded populations.
export const activityOutcomes: Record<Activity, AuditOutcome[]> = {
  attempts: ["success", "tool_error", "upstream_error", "upstream_unavailable", "upstream_timeout"],
  failures: ["tool_error", "upstream_error", "upstream_unavailable", "upstream_timeout"],
  durations: ["success", "tool_error"],
};
