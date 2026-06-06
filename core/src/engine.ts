import { StateGraph, END } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { AgentState, AgentStateType } from "./schema.js";
import { WorkflowSchema } from './schemaDefinitions.js';
import { createDynamicNode } from "./nodeFactory.js";
import { WorkflowObserver } from "./observer.js";

export class HardGateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HardGateError";
    }
}

export const checkpointer = new MemorySaver();

/**
 * UNIVERSAL SCHEMA-DRIVEN ROUTER
 */
export function createUniversalRouter(schema: WorkflowSchema, currentStateName: string, observers: WorkflowObserver[] = []) {
    return (state: AgentStateType): string => { // Explicitly tell tsc we return a string path
        const { _stepCount, _maxSteps, _threadId } = state;
        const condition = state._transitionState;

        // 1. SYSTEM CIRCUIT BREAKERS (Priority #1 Framework Override Governance)
        const terminalStates = ["auditor", "responder"];

        if (!terminalStates.includes(currentStateName)) {
            // A. Global Max Step Count Safety Valve Exhaustion
            if (_stepCount >= _maxSteps) {
                observers.forEach(o => o.onCircuitBreaker?.(currentStateName, _stepCount, _maxSteps, _threadId || "unknown"));
                return "auditor";
            }

            // B. Autonomous Cyclic Recursion Safety Valve Intersection
            if (
                condition === "FAILURE" &&
                state._transitionReason?.includes("Cycle breaker tripped")
            ) {
                observers.forEach(o => o.onCircuitBreaker?.(currentStateName, _stepCount, _maxSteps, _threadId || "unknown"));
                return "auditor";
            }
        }

        const stateDefinition = schema.states[currentStateName];
        if (!stateDefinition) {
            throw new Error(`State '${currentStateName}' not found in schema.`);
        }

        // 0. System Halts
        if (condition === "__SUSPEND__") {
            observers.forEach(o => o.onTransition?.(currentStateName, "__SUSPEND__", "SUSPEND", _threadId || "unknown"));
            return "__SUSPEND__";
        }

        // 1. Specific Match
        for (const transition of stateDefinition.transitions) {
            if (transition.condition === condition) {
                observers.forEach(o => o.onTransition?.(currentStateName, transition.nextState, condition || "NONE", _threadId || "unknown"));
                return transition.nextState;
            }
        }

        // =====================================================================
        // 🛡️ RUNTIME INTERCEPT VALVE (No Fallbacks Allowed)
        // =====================================================================
        // Something unexpected came up. Commit forensic reasoning back into the 
        // mutable state object reference by mutation key so downstream nodes can read it.
        state._transitionState = "FAILURE";
        state._transitionReason = `No transition found for state '${currentStateName}' with condition '${condition || "UNDEFINED"}'. Define an explicit transition mapping.`;

        // Forcefully route the state out of user land straight into the framework security auditor
        return "auditor";
    };
}

/**
 * DYNAMIC GRAPH COMPILER
 */
export function createWorkflowGraph(schema: WorkflowSchema, observers: WorkflowObserver[] = []) {
    const builder = new StateGraph(AgentState);

    // 1. Add all nodes from schema
    for (const [stateName, stateDef] of Object.entries(schema.states)) {
        builder.addNode(stateName, createDynamicNode(stateName, stateDef, schema, observers));
    }

    // 2. Add Start Edge
    builder.addConditionalEdges("__start__", ((state: AgentStateType) => {
        return (state._currentStateId && schema.states[state._currentStateId]) ? state._currentStateId : schema.initialState;
    }) as any);

    // 2b. Add Suspend Node
    builder.addNode("__SUSPEND__", async (state) => state); // No-op for halting
    builder.addEdge("__SUSPEND__" as any, END as any);

    // 3. Add Conditional Edges (Routing)
    for (const stateName of Object.keys(schema.states)) {
        builder.addConditionalEdges(stateName as any, createUniversalRouter(schema, stateName, observers));
    }

    // 3b. Add Core Framework Fallback Structural Paths for Terminal Targets
    // Ensures that even if the incoming schema lacks "auditor" or "responder" in its native 
    // dictionary layout nodes, LangGraph's compiler edge matrix compiles without throwing errors.
    if (!schema.states["auditor"]) {
        builder.addNode("auditor", async (state) => {
            return { _transitionState: "COMPLETE", _terminationReason: state._context.lastError || "Framework panic shutdown." };
        });

        builder.addConditionalEdges("auditor" as any, () => END as any);
    }

    return builder;
}

/**
 * COMPILE WORKFLOW (High-level entry point)
 */
export function compileWorkflow(schema: WorkflowSchema, observers: WorkflowObserver[] = [], checkpointerOverride?: any) {
    const builder = createWorkflowGraph(schema, observers);

    // Auto-detect HITL states for interrupts
    const interruptBefore = Object.entries(schema.states)
        .filter(([_, def]) => def.hitl || def.action?.requiresApproval)
        .map(([name]) => name);

    // Always interrupt before SUSPEND so we can dehydrate
    interruptBefore.push("__SUSPEND__");

    return builder.compile({
        checkpointer: checkpointerOverride || checkpointer,
        interruptBefore: interruptBefore as any
    });
}