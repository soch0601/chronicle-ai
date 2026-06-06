import { MessagesAnnotation, Annotation } from "@langchain/langgraph";

/**
 * Core Agent State for the AI Harness.
 * System-level variables are prefixed with '_' to avoid collisions with user data.
 * 
 * Framework variables:
 * - messages: The conversation history (LangGraph standard).
 * - _context: A dynamic pool for all user/domain-specific data.
 * - _transitionState: The condition key for the next state transition.
 * - _transitionReason: Audit trail explaining why a transition was chosen.
 * - _currentStateId: Tracks the active node for observability.
 * - _threadId: Current conversation session identifier.
 * - _stepCount / _maxSteps: Safety counters for execution control.
 * - _terminationReason: Final status message upon workflow completion.
 * - _humanInput: Temporary storage for HITL data.
 * - _lastUsage: Token metrics for the most recent step.
 * - _cumulativeUsage: Running total of tokens/costs for the entire thread.
 */
export const AgentState = Annotation.Root({
    ...MessagesAnnotation.spec,

    /** User domain data */
    _context: Annotation<Record<string, any>>({
        reducer: (x, y) => ({ ...x, ...y }),
        default: () => ({}),
    }),

    /** Routing & Audit */
    _transitionState: Annotation<string | null>({
        reducer: (x, y) => y !== undefined ? y : x,
        default: () => null,
    }),
    _transitionReason: Annotation<string | null>({
        reducer: (x, y) => y !== undefined ? y : x,
        default: () => null,
    }),
    _resumePhase: Annotation<"action" | "verification" | null>({
        reducer: (x, y) => y !== undefined ? y : x,
        default: () => null,
    }),

    /** Framework Metadata */
    _threadId: Annotation<string | null>({
        reducer: (x, y) => y ?? x,
    }),
    _currentStateId: Annotation<string | null>({
        reducer: (x, y) => y ?? x,
    }),
    _stepCount: Annotation<number>({
        reducer: (x, y) => y ?? x,
        default: () => 0,
    }),
    _maxSteps: Annotation<number>({
        reducer: (x, y) => y ?? x,
        default: (context?: any) => {
            if (context && typeof context.maxSteps === 'number') {
                return context.maxSteps;
            }
            if (context && context.states) {
                return calculateMaxSteps(context.states);
            }
            return 20; // Safe global fallback floor if context isn't fully initialized yet
        },
    }),
    _cycleCount: Annotation<Record<string, number>>({
        reducer: (x, y) => {
            // A clean wipe action passes an empty object to reset on HITL gates
            if (y && Object.keys(y).length === 0) return {};
            return { ...x, ...y };
        },
        default: () => ({}),
    }),
    _maxCycles: Annotation<number>({
        reducer: (x, y) => y ?? x,
        default: () => 3, // Cut off tight recursive loops after 3 consecutive passes
    }),
    _terminationReason: Annotation<string | null>({
        reducer: (x, y) => y ?? x,
        default: () => null,
    }),

    _humanInput: Annotation<any | null>({
        reducer: (x, y) => y !== undefined ? y : x,
        default: () => null,
    }),

    /** Production Economics */
    _lastUsage: Annotation<TokenUsage | null>({
        reducer: (x, y) => y ?? x,
        default: () => null,
    }),
    _cumulativeUsage: Annotation<TokenUsage>({
        reducer: (x, y) => ({
            promptTokens: (x?.promptTokens || 0) + (y?.promptTokens || 0),
            completionTokens: (x?.completionTokens || 0) + (y?.completionTokens || 0),
            totalTokens: (x?.totalTokens || 0) + (y?.totalTokens || 0),
            estimatedCost: (x?.estimatedCost || 0) + (y?.estimatedCost || 0),
        }),
        default: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 }),
    }),
});

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost?: number;
}

/**
 * Export the State Type for function signatures and type safety.
 */
export type AgentStateType = typeof AgentState.State;

export function calculateMaxSteps(statesMap: Record<string, any>): number {
    const stateCount = statesMap ? Object.keys(statesMap).length : 5;
    return Math.max(Math.min(stateCount * 3, 100), 20);
}
