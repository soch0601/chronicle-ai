import { createWorkflowGraph } from '../src/engine.js';
import { WorkflowSchema } from '../src/schemaDefinitions.js';
import { WorkflowObserver } from '../src/observer.js';

describe("Streaming Output Integration", () => {
    it("emits real-time ACTION_STREAM traces during bash execution", async () => {
        const schema: WorkflowSchema = {
            name: "StreamingWorkflow",
            version: "1.0.0",
            initialState: "start",
            agents: {},
            states: {
                "start": {
                    action: { 
                        type: "bash", 
                        // Cross-platform node script to print two chunks with a delay
                        command: 'node -e "console.log(\'CHUNK1\'); setTimeout(() => console.log(\'CHUNK2\'), 100);"' 
                    },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" },
                        { condition: "FAILURE", nextState: "__END__" }
                    ]
                }
            }
        };

        const emittedChunks: string[] = [];

        const mockObserver: WorkflowObserver = {
            onTrace: (type, message, metadata) => {
                if (type === "ACTION_STREAM" && metadata?.stream === 'stdout') {
                    emittedChunks.push(message.trim());
                }
            }
        };

        const workflow = createWorkflowGraph(schema, [mockObserver]);
        const app = workflow.compile();

        await app.invoke({
            messages: [],
            _stepCount: 0,
            _maxSteps: 15,
            _threadId: "stream-thread",
            _context: {}
        }, { configurable: { thread_id: "stream-thread" } });

        // Filter out empty lines that might be emitted
        const cleanChunks = emittedChunks.filter(c => c.length > 0);
        
        // We should have received CHUNK1 and CHUNK2 as distinct stream trace events
        expect(cleanChunks).toContain("CHUNK1");
        expect(cleanChunks).toContain("CHUNK2");
        expect(cleanChunks.length).toBeGreaterThanOrEqual(2);
    });
});
