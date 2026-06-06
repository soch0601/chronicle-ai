import { createUniversalRouter } from "../src/engine.js";
import { WorkflowSchema } from "../src/schemaDefinitions.js";
import { AgentState } from "../src/schema.js";
import { jest } from '@jest/globals';

describe("createUniversalRouter", () => {
    let mockSchema: WorkflowSchema;

    beforeEach(() => {
        jest.clearAllMocks();
        mockSchema = {
            name: "TestSchema",
            version: "1.0.0",
            initialState: "stateA",
            agents: {},
            states: {
                stateA: {
                    action: { type: "function" },
                    verification: { type: "function", expectedOutputs: ["SUCCESS", "FAILURE"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "stateB" },
                        { condition: "FAILURE", nextState: "stateC" }
                    ]
                }
            }
        };
    });

    it("routes based on transitionState matching a condition", () => {
        const router = createUniversalRouter(mockSchema, "stateA");
        const state = {
            ...AgentState.State,
            _stepCount: 1,
            _maxSteps: 10,
            _transitionState: "SUCCESS"
        } as any;

        const nextNode = router(state);
        expect(nextNode).toBe("stateB");
    });

    it("intercepts and routes to auditor when transitionState is null (Strict Fallback Intercept)", () => {
        const router = createUniversalRouter(mockSchema, "stateA");
        const state = {
            ...AgentState.State,
            _stepCount: 1,
            _maxSteps: 10,
            _transitionState: null
        } as any;

        const nextNode = router(state);

        // Assert that strict rules force an abort straight to the auditor
        expect(nextNode).toBe("auditor");
        expect(state._transitionState).toBe("FAILURE");
        expect(state._transitionReason).toContain("No transition found for state 'stateA' with condition 'UNDEFINED'");
    });

    it("trips the circuit breaker if stepCount >= maxSteps", () => {
        const router = createUniversalRouter(mockSchema, "stateA");
        const state = {
            ...AgentState.State,
            _stepCount: 10,
            _maxSteps: 10,
            _transitionState: "SUCCESS"
        } as any;

        const nextNode = router(state);
        expect(nextNode).toBe("auditor");
    });

    it("throws an error if state is not found in schema", () => {
        const router = createUniversalRouter(mockSchema, "nonExistentState");
        const state = {
            ...AgentState.State,
            _stepCount: 1,
            _maxSteps: 10,
            _transitionState: "SUCCESS"
        } as any;

        expect(() => router(state)).toThrow("State 'nonExistentState' not found in schema.");
    });

    it("safely aborts to the auditor with FAILURE status if no transition matches", () => {
        const router = createUniversalRouter(mockSchema, "stateA");
        const state = {
            ...AgentState.State,
            _stepCount: 1,
            _maxSteps: 10,
            _transitionState: "UNMAPPED_STATE"
        } as any;

        const nextNode = router(state);

        // Under the strict architecture, we no longer throw an unhandled JS error. 
        // We mutate the state by reference and divert cleanly to the security auditor.
        expect(nextNode).toBe("auditor");
        expect(state._transitionState).toBe("FAILURE");
        expect(state._transitionReason).toContain("No transition found for state 'stateA' with condition 'UNMAPPED_STATE'");
    });
});