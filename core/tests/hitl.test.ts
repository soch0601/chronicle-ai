import { getMockPath } from './utils/mockPaths.js';
import { jest } from '@jest/globals';
import { MemorySaver } from "@langchain/langgraph";

// 1. Setup Framework Mocks
await jest.unstable_mockModule('../src/dataReplay.js', () => ({
    writeState: jest.fn(),
    readState: jest.fn()
}));

const { compileWorkflow } = await import("../src/engine.js");
const { agentManager } = await import("../src/agentManager.js");

const hitlSchema = {
    name: "HITLTestWorkflow",
    version: "1.0.0",
    initialState: "start",
    agents: {
        "mock-agent": { provider: "mock" }
    },
    states: {
        "start": {
            action: { type: "bash", command: "echo starting" },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: [
                { condition: "SUCCESS", nextState: "approvalStep" }
            ]
        },
        "approvalStep": {
            hitl: {
                type: "approval",
                prompt: "Proceed to final step?",
                options: ["APPROVED", "REJECTED"]
            },
            action: { type: "bash", command: "echo 'THIS SHOULD NEVER RUN'" },
            verification: { 
                type: "function", 
                path: getMockPath(import.meta.url, 'hitlVerification.js'), 
                expectedOutputs: ["SUCCESS", "REJECTED", "FAILURE"] 
            },
            stateVariables: { read: [], write: [] },
            transitions: [
                { condition: "SUCCESS", nextState: "finalStep" },
                { condition: "REJECTED", nextState: "start" }
            ]
        },
        "finalStep": {
            action: { type: "bash", command: "echo done" },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: [
                { condition: "SUCCESS", nextState: "__END__" }
            ]
        }
    }
};

describe("Human-in-the-Loop (HITL) Integration", () => {
    let checkpointer: any;

    beforeEach(() => {
        checkpointer = new MemorySaver();
        jest.clearAllMocks();
    });

    it("pauses execution before a HITL-enabled state", async () => {
        const agent = compileWorkflow(hitlSchema as any, [], checkpointer);
        const threadId = "hitl-pause-test";
        const config = { configurable: { thread_id: threadId } };

        // Start workflow
        const result = await agent.invoke({
            messages: [],
            _threadId: threadId,
            _stepCount: 0
        }, config);

        // LangGraph should stop BEFORE approvalStep
        const state = await agent.getState(config);
        expect(state.next).toContain("approvalStep");
        expect(result._currentStateId).toBe("start");
    });

    it("resumes correctly when human input is provided", async () => {
        const agent = compileWorkflow(hitlSchema as any, [], checkpointer);
        const threadId = "hitl-resume-test";
        const config = { configurable: { thread_id: threadId } };

        // 1. Run until pause
        await agent.invoke({ messages: [], _threadId: threadId, _stepCount: 0 }, config);

        // 2. Provide human input via state update
        await agent.updateState(config, {
            _humanInput: { decision: "APPROVED" }
        });

        // 3. Resume (invoke with null to continue from checkpoint)
        const result = await agent.invoke(null, config);

        // LangGraph runs until the NEXT interrupt or __END__
        // It should have completed approvalStep and finalStep
        expect(result._transitionState).toBe("SUCCESS");
        expect(result._humanInput).toBeNull(); 

        // 4. Verify it finished or is at the end
        const state = await agent.getState(config);
        expect(state.next).toEqual([]); // Should be finished (__END__)
    });

    it("routes to REJECTED path when human rejects", async () => {
        const agent = compileWorkflow(hitlSchema as any, [], checkpointer);
        const threadId = "hitl-reject-test";
        const config = { configurable: { thread_id: threadId } };

        await agent.invoke({ messages: [], _threadId: threadId, _stepCount: 0 }, config);

        await agent.updateState(config, {
            _humanInput: { decision: "REJECTED" }
        });

        // This should run approvalStep (REJECTED) -> start (SUCCESS) -> pause before approvalStep
        const result = await agent.invoke(null, config);

        expect(result._currentStateId).toBe("start");
        expect(result._transitionState).toBe("SUCCESS");
        
        const state = await agent.getState(config);
        expect(state.next).toContain("approvalStep");
    });

    it("throws error if resumed without humanInput", async () => {
        const agent = compileWorkflow(hitlSchema as any, [], checkpointer);
        const threadId = "hitl-error-test";
        const config = { configurable: { thread_id: threadId } };

        await agent.invoke({ messages: [], _threadId: threadId, _stepCount: 0 }, config);

        // Resume without updateState
        await expect(agent.invoke(null, config)).rejects.toThrow(/requires human input\/approval/);
    });
});
