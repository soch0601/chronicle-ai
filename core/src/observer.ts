import { AgentStateType } from "./schema.js";

/**
 * The data structure returned by a state node completion.
 */
export interface NodeResult {
    transitionState: string | null;
    stepCount: number;
    lastError?: string | null;
    terminationReason?: string | null;
    [key: string]: any; // Allow other state updates
}

/**
 * Interface for pluggable workflow observability.
 * Allows various backends (JSON file, OpenTelemetry, Datadog, etc.) 
 * to monitor the AI Harness execution without being coupled to the core.
 */
export interface WorkflowObserver {
    /** Called when a state node begins execution */
    onNodeStart?(nodeName: string, state: AgentStateType): void | Promise<void>;

    /** Called when a state node completes execution */
    onNodeEnd?(nodeName: string, state: AgentStateType, result: NodeResult): void | Promise<void>;

    /** Called when a transition between states occurs */
    onTransition?(from: string, to: string, reason: string, threadId: string): void | Promise<void>;

    /** Called when a circuit breaker trips */
    onCircuitBreaker?(nodeName: string, stepCount: number, limit: number, threadId: string): void | Promise<void>;

    /** Called when an error occurs during node execution or routing */
    onError?(nodeName: string, error: Error, threadId: string): void | Promise<void>;

    /** Generic tracing for internal framework events (NODE_START, ACTION_FAILURE, etc.) */
    onTrace?(type: string, message: string, metadata?: any): void | Promise<void>;
}

