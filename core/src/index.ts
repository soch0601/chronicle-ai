
// 1. Export Public Configurations and Schemas (So they get perfect IDE Autocomplete)
export type {
    WorkflowSchema,
    StateDefinition,
    ActionDefinition,
    WorkflowSettings
} from "./schemaDefinitions.js";

export type {
    AgentState,
    AgentStateType,
    TokenUsage
} from "./schema.js";

// 2. Export the Unified Runtime Interface (The clean Black Box)
export { ChronicleEngine, HardGateError } from "./engine.js";

// 3. Export the Developer Utilities
export { toolRegistry } from "./toolRegistry.js";
export { agentManager } from "./agentManager.js";

// 4. Export public Observer / Telemetry interfaces
export type { WorkflowObserver } from "./observer.js";

// 5. Clean, high-level types
import { compileWorkflow } from "./engine.js";
export type HarnessAgent = ReturnType<typeof compileWorkflow>;