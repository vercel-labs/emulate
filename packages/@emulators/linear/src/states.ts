import type { LinearWorkflowState, LinearWorkflowStateType } from "./entities.js";

// The colors of the workflow states Linear creates for a new team.
const DEFAULT_STATE_COLORS: Record<LinearWorkflowStateType, string> = {
  backlog: "#bec2c8",
  unstarted: "#e2e2e2",
  started: "#f2c94c",
  completed: "#5e6ad2",
  canceled: "#95a2b3",
};

export function workflowStateColor(state: Pick<LinearWorkflowState, "color" | "type">): string {
  return state.color ?? DEFAULT_STATE_COLORS[state.type] ?? DEFAULT_STATE_COLORS.unstarted;
}
