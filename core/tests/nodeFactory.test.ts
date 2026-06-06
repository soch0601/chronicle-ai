import { jest } from '@jest/globals';
import { AgentStateType } from "../src/schema.js";
import { StateDefinition, WorkflowSchema } from "../src/schemaDefinitions.js";

// 1. Setup Framework Mocks (Only src/ internals)
await jest.unstable_mockModule('../src/dataReplay.js', () => ({
    writeState: jest.fn(),
    readState: jest.fn()
}));

// 2. Import Framework Core
const { createDynamicNode } = await import("../src/nodeFactory.js");
const { agentManager } = await import("../src/agentManager.js");
const { toolRegistry } = await import("../src/toolRegistry.js");

describe('Node Factory', () => {
    const mockWorkflow: WorkflowSchema = {
        name: "Test",
        version: "1.0.0",
        initialState: "start",
        agents: {
            "test-agent": { provider: "mock", model: "test" }
        },
        states: {}
    };

    beforeAll(async () => {
        // Register mock agent
        const mockModel = {
            invoke: jest.fn(),
            _getType: () => "chat"
        } as any;
        agentManager.defineAgent("test-agent", mockModel);

        // Register mock MCP tools
        toolRegistry.registerTool("mock_mcp_action", {
            invoke: jest.fn<any>().mockResolvedValue({
                update: {
                    context: {
                        mcpOutput: "action_success"
                    }
                }
            })
        });

        toolRegistry.registerTool("mock_mcp_verify", {
            invoke: jest.fn<any>().mockResolvedValue({
                update: {
                    transitionState: "SUCCESS"
                }
            })
        });
    });

    const mockState: any = {
        _context: {
            secret: "hidden",
            input: "visible",
            other: "stuff"
        },
        _stepCount: 0,
        _threadId: "test-thread",
        _maxCycles: 3, // Trip exactly on the 4th validation attempt
        _cycleCount: {},
        messages: []
    };

    it('should only provide allowed variables to the runner (Read Filter)', async () => {
        const stateDef: StateDefinition = {
            action: { type: "bash", command: "echo $INPUT" },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: ["input"], write: [] },
            transitions: []
        };

        const node = createDynamicNode("testState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("SUCCESS");
        expect(result._stepCount).toBe(1);
    });

    it('should handle bash failures gracefully', async () => {
        const stateDef: StateDefinition = {
            action: { type: "bash", command: "nonexistent_command_that_fails" },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: []
        };

        const node = createDynamicNode("errorState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("FAILURE");
    });

    it('should execute MCP tools from registry and extract updates', async () => {
        const stateDef: StateDefinition = {
            action: { type: "mcp", name: "mock_mcp_action" },
            verification: { type: "mcp", name: "mock_mcp_verify", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: ["input"], write: ["mcpOutput"] },
            transitions: []
        };

        const node = createDynamicNode("mcpState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("SUCCESS");
        expect(result._context).toHaveProperty("mcpOutput", "action_success");
        expect(result._stepCount).toBe(1);
    });

    it('should validate action results against outputSchema', async () => {
        const { z } = await import("zod");
        const schema = z.object({
            id: z.number(),
            status: z.string()
        });

        const stateDef: StateDefinition = {
            action: { type: "mcp", name: "mock_mcp_action" },
            outputSchema: schema,
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: ["id", "status"] },
            transitions: []
        };

        const tool = toolRegistry.getTool("mock_mcp_action");
        (tool.invoke as any).mockResolvedValueOnce({
            update: { context: { id: 1, status: "ok" } }
        });

        const node = createDynamicNode("schemaState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("SUCCESS");

        (tool.invoke as any).mockResolvedValueOnce({
            update: { context: { id: "not_a_number", status: "ok" } }
        });

        const failResult = await node(mockState as AgentStateType);
        expect(failResult._transitionState).toBe("VALIDATION_ERROR");
        expect(failResult._context.lastValidationError).toContain("id: Expected number, received string");
    });

    it('should enforce verification outputs match expectedOutputs', async () => {
        const stateDef: StateDefinition = {
            action: { type: "bash", command: "echo action" },
            verification: { type: "bash", command: "echo UNEXPECTED", expectedOutputs: ["SUCCESS", "FAILURE"] },
            stateVariables: { read: [], write: [] },
            transitions: []
        };

        const node = createDynamicNode("enforcementState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("FAILURE");
        expect(result._transitionReason).toContain("Invalid verification state 'UNEXPECTED'");
    });

    it('should support mapping primitive action results to state variables', async () => {
        toolRegistry.registerTool("primitive_tool", {
            invoke: jest.fn<any>().mockResolvedValue("Chris")
        });

        const stateDef: StateDefinition = {
            action: { type: "mcp", name: "primitive_tool" },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: ["userName"] },
            transitions: []
        };

        const node = createDynamicNode("primitiveState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("SUCCESS");
        expect(result._context).toHaveProperty("userName", "Chris");
    });

    it('should inject action.args into the payload for function actions', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const tmpActionPath = path.join(process.cwd(), 'tests', 'mocks', 'argsAction.js');
        fs.writeFileSync(tmpActionPath, `
            export const run = async function(payload) {
                return { outArg1: payload.arg1, outArg2: payload.arg2 };
            };
            export const verify = async function() { return "SUCCESS"; };
        `);

        const stateDef: StateDefinition = {
            action: { type: "function", path: tmpActionPath, args: { arg1: "hello", arg2: "world" } } as any,
            verification: { type: "function", path: tmpActionPath, expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: ["outArg1", "outArg2"] },
            transitions: []
        };

        const node = createDynamicNode("argsState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        if (result._transitionState === "FAILURE") console.error(result._context.lastError || result._transitionReason);
        expect(result._transitionState).toBe("SUCCESS");
        expect(result._context).toHaveProperty("outArg1", "hello");
        expect(result._context).toHaveProperty("outArg2", "world");

        fs.unlinkSync(tmpActionPath);
    });

    // =========================================================================
    // 🛡️ ADVANCED CIRCUIT BREAKER SUITE
    // =========================================================================

    it("🛡️ [Test 1] should catch a tight 1-state self-loop and return a failure payload signature upon crossing thresholds", async () => {
        // 1. Define a completely self-contained, valid mock StateDefinition layout
        const mockStateDef: any = {
            stateVariables: { read: [], write: [] },
            action: {
                type: "bash",
                command: "echo unit_test_loop",
                timeout: 5000
            },
            transitions: []
        };

        // 2. Pass our self-contained definition directly into the factory instantiation call
        const nodeExecutor = createDynamicNode("autonomous_self_loop", mockStateDef, mockWorkflow || { name: "test-wf", version: "1.0.0", states: {} });
        const emptyConfig = {};

        // Pass 1: Registers visitation -> 1
        let result = await nodeExecutor({ ...mockState, _cycleCount: {} }, emptyConfig);
        expect(result._cycleCount["autonomous_self_loop"]).toBe(1);

        // Pass 2: Registers visitation -> 2
        result = await nodeExecutor({ ...mockState, _cycleCount: result._cycleCount, _stepCount: 1 }, emptyConfig);
        expect(result._cycleCount["autonomous_self_loop"]).toBe(2);

        // Pass 3: Registers visitation -> 3 (Ceiling threshold hit)
        result = await nodeExecutor({ ...mockState, _cycleCount: result._cycleCount, _stepCount: 2 }, emptyConfig);
        expect(result._cycleCount["autonomous_self_loop"]).toBe(3);

        // Pass 4 -> Triggers the framework's internal loop-break return signature
        const trappedPayload = await nodeExecutor({ ...mockState, _cycleCount: result._cycleCount, _stepCount: 3 }, emptyConfig);

        // Assert the factory cleanly flags it as a system FAILURE so the Universal Router can catch it downstream
        expect(trappedPayload._transitionState).toBe("FAILURE");
        expect(trappedPayload._transitionReason).toContain("Cycle breaker tripped");
        expect(trappedPayload._cycleCount).toEqual({});
    });
});