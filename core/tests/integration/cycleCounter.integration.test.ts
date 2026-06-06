import { jest } from '@jest/globals';
import { StateGraph, END, MemorySaver } from "@langchain/langgraph";
import { AgentState, AgentStateType } from "../../src/schema.js";
import { WorkflowSchema, StateDefinition } from "../../src/schemaDefinitions.js";

// 1. Mock out data replay ledger
await jest.unstable_mockModule('../../src/dataReplay.js', () => ({
    writeState: jest.fn(),
    readState: jest.fn()
}));

// 2. Import framework primitives natively
const { createDynamicNode } = await import("../../src/nodeFactory.js");
const { createUniversalRouter } = await import("../../src/engine.js"); // 👈 Use the real router!

describe("🔗 PrismEngine State Immutability Integration Spec", () => {
    let mockWorkflow: WorkflowSchema;

    beforeEach(() => {
        mockWorkflow = {
            name: "strict-serialization-test",
            version: "1.0.0",
            initialState: "faulty_validation_node",
            agents: {},
            states: {
                faulty_validation_node: {
                    stateVariables: { read: [], write: [] },
                    action: { type: "bash", command: "echo loop_step" },
                    // 🛡️ THE LOOP EDGE CONTRACT:
                    // Force the universal router to loop validation errors back 
                    // until our cycle breaker drops the anvil on pass 4!
                    transitions: [
                        { condition: "VALIDATION_ERROR", nextState: "faulty_validation_node" },
                        { condition: "default", nextState: "__END__" }
                    ]
                } as any,

                auditor: {
                    stateVariables: { read: [], write: [] },
                    action: { type: "bash", command: "echo auditor_fallback" },
                    transitions: [{ condition: "default", nextState: "__END__" }]
                } as any
            }
        };
    });

    it("🛡️ should route safely to the auditor node when the universal router detects a cycle break", async () => {
        // Grab the state schema declaration we populated above
        const stateDef = mockWorkflow.states["faulty_validation_node"];

        // Force an outputSchema validation failure to simulate recursive model loop mechanics
        stateDef.outputSchema = {
            safeParse: () => ({ success: false, error: { errors: [{ path: ["id"], message: "Invalid payload layout" }] } })
        } as any;

        const executorNode = createDynamicNode("faulty_validation_node", stateDef, mockWorkflow);

        const checkpointer = new MemorySaver();
        const workflowGraph = new StateGraph(AgentState)
            .addNode("faulty_validation_node", executorNode)
            .addNode("auditor", async (state) => {
                return { _transitionState: "COMPLETE", _terminationReason: "Auditor caught loop panic thread." };
            });

        // Use the true core package router engine
        workflowGraph.addConditionalEdges(
            "faulty_validation_node",
            createUniversalRouter(mockWorkflow, "faulty_validation_node", [])
        );
        workflowGraph.addConditionalEdges("auditor" as any, () => END as any);

        workflowGraph.setEntryPoint("faulty_validation_node");
        const compiledApp = workflowGraph.compile({ checkpointer });

        const initialRuntimeState = {
            _context: {},
            _stepCount: 0,
            _maxSteps: 30,
            _maxCycles: 3, // Trip on pass 4
            _cycleCount: {},
            messages: []
        };

        const finalState: any = await compiledApp.invoke(initialRuntimeState, { configurable: { thread_id: "int_thread_789" } });

        // =====================================================================
        // TRUE SYSTEM GOVERNANCE ASSERTIONS
        // =====================================================================
        expect(finalState._transitionState).toBe("COMPLETE");
        expect(finalState._terminationReason).toBe("Auditor caught loop panic thread.");
        expect(finalState._stepCount).toBe(3);
    });
});