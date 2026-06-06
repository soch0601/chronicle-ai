import { getMockPath } from './utils/mockPaths.js';
import { jest } from '@jest/globals';

const { compileWorkflow } = await import("../src/engine.js");
const { AgentState } = await import("../src/schema.js");

describe("Dehydration & Orchestration Integration", () => {

    const mockOrchestrator = {
        setCount: jest.fn(),
        atomicDecrementCount: jest.fn()
    };

    const mockSchema: any = {
        name: "DehydrationWorkflow",
        version: "1.0.0",
        initialState: "start",
        settings: {
            orchestrator: mockOrchestrator
        },
        states: {
            "start": {
                action: { type: "function", path: getMockPath(import.meta.url, 'testAction.js') },
                verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS", "FAILURE"] },
                stateVariables: { read: [], write: ["testValue"] },
                transitions: [{ condition: "SUCCESS", nextState: "fanOutNode" }]
            },
            "fanOutNode": {
                action: { type: "function", path: getMockPath(import.meta.url, 'fanOutAction.js') }, // Returns __SUSPEND__
                verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS"] },
                stateVariables: { read: [], write: ["aggregatedResults"] },
                transitions: [{ condition: "SUCCESS", nextState: "endState" }]
            },
            "endState": {
                action: { type: "function", path: getMockPath(import.meta.url, 'testAction.js') },
                verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS"] },
                stateVariables: { read: [], write: [] },
                transitions: [{ condition: "SUCCESS", nextState: "__END__" }]
            }
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("halts execution when action returns __SUSPEND__", async () => {
        const app = compileWorkflow(mockSchema);
        
        const initialState = {
            messages: [],
            _currentStateId: "fanOutNode",
            _stepCount: 0,
            _context: {}
        };

        const result = await app.invoke(initialState, { configurable: { thread_id: "test-thread-suspend" } });
        
        // It should run fanOutNode, then transition to __SUSPEND__, and halt.
        // It should NOT reach endState.
        expect(result._currentStateId).toBe("fanOutNode");
        expect(result._transitionState).toBe("__SUSPEND__");
        expect(mockOrchestrator.setCount).toHaveBeenCalledWith("test-key", 5);
    });

    it("routes __start__ directly to _currentStateId if provided", async () => {
        const app = compileWorkflow(mockSchema);

        const initialState = {
            messages: [],
            _currentStateId: "endState", // Should skip 'start' and 'fanOutNode'
            _stepCount: 0,
            _context: {}
        };

        const result = await app.invoke(initialState, { configurable: { thread_id: "test-thread" } });
        
        // It should have executed endState and finished
        expect(result._currentStateId).toBe("endState");
        expect(result._transitionState).toBe("SUCCESS");
    });

    it("skips action phase when _resumePhase is 'verification'", async () => {
        const app = compileWorkflow(mockSchema);

        const initialState = {
            messages: [],
            _currentStateId: "fanOutNode",
            _resumePhase: "verification" as const,
            _context: {
                actionResult: { aggregated: true } // This skips action phase and feeds directly to verification
            },
            _stepCount: 0
        };

        const result = await app.invoke(initialState, { configurable: { thread_id: "test-thread-2" } });
        
        // Because _resumePhase was 'verification', fanOutAction.js (which suspends) is skipped.
        // It goes straight to verification, succeeds, and routes to endState.
        // Wait, verification will just say SUCCESS. Then routes to endState.
        // And endState will run normally.
        
        expect(result._currentStateId).toBe("endState");
        expect(result._resumePhase).toBeNull(); // Should be cleared
    });
});
