import { getMockPath } from '../utils/mockPaths.js';
import { jest } from '@jest/globals';
import { IOrchestrationProvider, WorkflowSchema } from '../../src/schemaDefinitions.js';
import { compileWorkflow } from '../../src/engine.js';

class InMemoryOrchestrator implements IOrchestrationProvider {
    private counters: Map<string, number> = new Map();

    async setCount(key: string, count: number): Promise<void> {
        this.counters.set(key, count);
    }

    async atomicDecrementCount(key: string): Promise<number> {
        const current = this.counters.get(key) || 0;
        const next = Math.max(0, current - 1);
        this.counters.set(key, next);
        return next;
    }
}

describe("Fan-Out / Fan-In Integration", () => {

    const orchestrator = new InMemoryOrchestrator();

    const mockSchema: WorkflowSchema = {
        name: "DistributedWorkflow",
        version: "1.0.0",
        initialState: "start",
        settings: {
            orchestrator
        },
        agents: {},
        states: {
            "start": {
                action: { type: "bash", command: "echo INITIALIZING" },
                verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                stateVariables: { read: [], write: [] },
                transitions: [{ condition: "SUCCESS", nextState: "fanOutNode" }]
            },
            "fanOutNode": {
                action: { type: "function", path: getMockPath(import.meta.url, 'fanOutIntegrationAction.js') },
                verification: { type: "function", path: getMockPath(import.meta.url, 'fanOutIntegrationVerification.js'), expectedOutputs: ["SUCCESS", "FAILURE"] },
                stateVariables: { read: [], write: ["pendingItems", "workerResults", "verified"] },
                transitions: [{ condition: "SUCCESS", nextState: "endState" }]
            },
            "endState": {
                action: { type: "bash", command: "echo DONE" },
                verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                stateVariables: { read: [], write: [] },
                transitions: [{ condition: "SUCCESS", nextState: "__END__" }]
            }
        }
    };

    it("successfully distributes work, tracks counts, and rehydrates parent", async () => {
        const app = compileWorkflow(mockSchema);
        const threadId = "fanout-test-thread";

        const initialState = {
            messages: [],
            _stepCount: 0,
            _context: {}
        };

        // 1. Kick off the workflow
        // It will run `start`, transition to `fanOutNode`.
        // `fanOutNode`'s action will set count to 3 and return _transitionState: "__SUSPEND__".
        // The framework will suspend execution.
        let result = await app.invoke(initialState, { configurable: { thread_id: threadId } });

        // Assert parent is suspended
        expect(result._currentStateId).toBe("fanOutNode");
        expect(result._transitionState).toBe("__SUSPEND__");
        expect(result._context.pendingItems).toEqual(["item1", "item2", "item3"]);
        expect(result._context.workerResults).toEqual([]);

        // 2. Simulate 3 separate worker processes handling the items
        let workerResultsData: string[] = [];

        async function mockWorkerTask(item: string) {
            // Worker does some async task
            await new Promise(resolve => setTimeout(resolve, 10));
            workerResultsData.push(item + "-processed");

            // Decrement Orchestrator
            const remaining = await orchestrator.atomicDecrementCount(threadId);

            // 3. Fan-In: The last worker triggers Rehydration
            if (remaining === 0) {
                // Construct the resumption payload
                const rehydrationPayload = {
                    _currentStateId: "fanOutNode",
                    _resumePhase: "verification" as const,
                    _context: {
                        actionResult: {
                            workerResults: workerResultsData
                        }
                    }
                };

                // REHYDRATE the graph on this "node"
                result = await app.invoke(rehydrationPayload, { configurable: { thread_id: threadId } });
            }
        }

        // Run the 3 workers concurrently
        await Promise.all([
            mockWorkerTask("item1"),
            mockWorkerTask("item2"),
            mockWorkerTask("item3")
        ]);

        // 4. Assert Final State
        expect(result._currentStateId).toBe("endState");
        expect(result._transitionState).toBe("SUCCESS");
        expect(result._context.workerResults).toHaveLength(3);
        expect(result._context.workerResults).toContain("item1-processed");
    });
});
