import { createWorkflowGraph } from '../../src/index.js';
import { WorkflowSchema } from '../../src/schemaDefinitions.js';
import { toolRegistry } from '../../src/toolRegistry.js';
import { getMockPath } from '../utils/mockPaths.js';

describe("AbortSignal & Cancellation Deep Integration", () => {
    
    beforeAll(() => {
        // Register a hanging MCP tool
        toolRegistry.registerTool("hang_tool", {
            name: "hang_tool",
            description: "Hangs until aborted",
            schema: {},
            invoke: async (input: any, signal?: AbortSignal) => {
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        resolve({ update: { transitionState: "SUCCESS" } });
                    }, 5000);
                    
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timeout);
                            reject(new Error("MCP Tool Aborted"));
                        });
                    }
                });
            }
        });
    });

    afterAll(() => {
        toolRegistry.clear();
    });

    const runHangingState = async (actionType: any, verificationType: any, actionOverrides: any = {}, verificationOverrides: any = {}) => {
        const schema: WorkflowSchema = {
            name: "AbortDeepWorkflow",
            version: "1.0.0",
            initialState: "start",
            agents: {},
            states: {
                "start": {
                    // Set timeout to 500ms
                    action: { type: actionType, ...actionOverrides, timeout: 500 },
                    verification: { type: verificationType, ...verificationOverrides, expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" },
                        { condition: "FAILURE", nextState: "__END__" }
                    ],
                    // We also ensure state timeout is bounded
                    timeout: 500
                }
            }
        };

        const workflow = createWorkflowGraph(schema, []);
        const app = workflow.compile();

        const startTime = Date.now();
        const result = await app.invoke({
            messages: [],
            _stepCount: 0,
            _maxSteps: 15,
            _threadId: "deep-abort",
            _context: {}
        }, { configurable: { thread_id: "deep-abort" } });

        const elapsed = Date.now() - startTime;
        return { result, elapsed };
    };

    it("aborts a hanging custom JS function action", async () => {
        const path = getMockPath(import.meta.url, 'hangFunction.js');
        const { result, elapsed } = await runHangingState("function", "bash", { path }, { command: "echo SUCCESS" });
        
        expect(elapsed).toBeLessThan(3000);
        expect(result._transitionState).toBe("FAILURE");
        expect(result._context.lastError).toContain("exceeded 500ms limit");
    });

    it("aborts a hanging MCP tool action", async () => {
        const { result, elapsed } = await runHangingState("mcp", "bash", { name: "hang_tool" }, { command: "echo SUCCESS" });
        
        expect(elapsed).toBeLessThan(3000);
        expect(result._transitionState).toBe("FAILURE");
        expect(result._context.lastError).toContain("exceeded 500ms limit");
    });

    it("aborts a hanging sub-workflow action", async () => {
        const path = getMockPath(import.meta.url, 'hangWorkflow.json');
        const { result, elapsed } = await runHangingState("workflow", "bash", { path }, { command: "echo SUCCESS" });
        
        expect(elapsed).toBeLessThan(4000);
        expect(result._transitionState).toBe("FAILURE");
        expect(result._context.lastError).toContain("exceeded 500ms limit");
    });

    it("aborts a hanging custom JS function verification", async () => {
        const path = getMockPath(import.meta.url, 'hangFunction.js');
        // Action is fast bash, Verification is hanging function
        const { result, elapsed } = await runHangingState("bash", "function", { command: "echo DONE" }, { path });
        
        expect(elapsed).toBeLessThan(3000);
        expect(result._transitionState).toBe("FAILURE");
        expect(result._transitionReason).toContain("exceeded 500ms limit");
    });

    it("aborts a hanging bash verification", async () => {
        // Action is fast bash, Verification is hanging bash
        const { result, elapsed } = await runHangingState("bash", "bash", { command: "echo DONE" }, { command: "node -e \"setTimeout(()=>{}, 5000)\"" });
        
        expect(elapsed).toBeLessThan(3000);
        expect(result._transitionState).toBe("FAILURE");
        expect(result._transitionReason).toContain("exceeded 500ms limit");
    });

    it("aborts a hanging MCP tool verification", async () => {
        // Action is fast bash, Verification is hanging MCP
        const { result, elapsed } = await runHangingState("bash", "mcp", { command: "echo DONE" }, { name: "hang_tool" });
        
        expect(elapsed).toBeLessThan(3000);
        expect(result._transitionState).toBe("FAILURE");
        expect(result._transitionReason).toContain("exceeded 500ms limit");
    });
});
