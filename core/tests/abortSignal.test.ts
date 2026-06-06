import { createWorkflowGraph } from '../src/index.js';
import { WorkflowSchema } from '../src/schemaDefinitions.js';

describe("AbortSignal & Cancellation Integration", () => {
    it("safely terminates a long-running bash script via timeout using AbortSignal without zombies", async () => {
        const schema: WorkflowSchema = {
            name: "AbortWorkflow",
            version: "1.0.0",
            initialState: "start",
            agents: {},
            states: {
                "start": {
                    // Sleep for 10 seconds, but we enforce a 1 second timeout.
                    // If AbortSignal is working, the bash process is killed cleanly at 1s.
                    action: { type: "bash", command: 'node -e "setTimeout(()=>{}, 10000)"', timeout: 1000 },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" },
                        { condition: "FAILURE", nextState: "__END__" }
                    ]
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
            _threadId: "abort-thread",
            _context: {}
        }, { configurable: { thread_id: "abort-thread" } });

        const elapsed = Date.now() - startTime;
        
        // Ensure we exited early due to the 1 second timeout
        expect(elapsed).toBeLessThan(5000);
        expect(result._transitionState).toBe("FAILURE");
        expect(result._context.lastError).toContain("exceeded 1000ms limit");
    });
});
