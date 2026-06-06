import { getMockPath } from './utils/mockPaths.js';
import { jest } from '@jest/globals';
import { AIMessage } from "@langchain/core/messages";

// 2. Import Framework Core
const { createWorkflowGraph, agentManager } = await import("../src/index.js");
const { createDynamicNode } = await import("../src/nodeFactory.js");

const mockStorage = {
    write: jest.fn(),
    read: jest.fn(),
    listThreads: jest.fn(),
    listSteps: jest.fn()
};

const testSchema: any = {
    name: "FrameworkTestWorkflow",
    version: "1.0.0",
    initialState: "start",
    settings: {
        tapeDir: "test-tapes",
        storage: mockStorage
    },
    agents: {
        "test-agent": { provider: "mock" }
    },
    states: {
        "start": {
            agent: "test-agent",
            action: { type: "function", path: getMockPath(import.meta.url, 'testAction.js') },
            verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS", "FAILURE"] },
            stateVariables: { read: [], write: ["testValue"] },
            transitions: [
                { condition: "SUCCESS", nextState: "endState" },
                { condition: "FAILURE", nextState: "start" }
            ]
        },
        "endState": {
            action: { type: "function", path: "tests/mocks/testAction.js" },
            verification: { type: "function", path: "tests/mocks/testVerification.js", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: [
                { condition: "SUCCESS", nextState: "__END__" }
            ]
        },
        "auditor": {
            action: { type: "function", path: getMockPath(import.meta.url, 'auditorAction.js') },
            verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: [
                { condition: "SUCCESS", nextState: "__END__" }
            ]
        }
    }
};

// 4. Mock Agent & Observer
const mockAgent = { invoke: jest.fn() };
agentManager.defineAgent("test-agent", mockAgent as any);

const mockObserver: any = {
    onNodeStart: jest.fn(),
    onNodeEnd: jest.fn(),
    onTrace: jest.fn(),
    onCircuitBreaker: jest.fn()
};

describe("Framework Engine Core", () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("Circuit Breaker", () => {
        it("stops execution and routes to auditor when stepCount exceeds maxSteps", async () => {
            const workflow = createWorkflowGraph(testSchema, [mockObserver]);
            const agent = workflow.compile();

            const state = {
                messages: [],
                _stepCount: 15,
                _maxSteps: 15,
                _context: {}
            };

            const result = await agent.invoke(state);

            expect(mockObserver.onCircuitBreaker).toHaveBeenCalled();
            expect(result._terminationReason).toContain("circuit breaker was tripped");
        });
    });

    describe("Observability", () => {
        it("emits onTrace events during node execution", async () => {
            const node = createDynamicNode("start", testSchema.states.start, testSchema, [mockObserver]);
            const state: any = {
                _context: {},
                _stepCount: 1,
                _threadId: "trace-thread",
                messages: []
            };

            await node(state);

            // Verify the framework emitted internal traces without knowing about the backend logger
            expect(mockObserver.onTrace).toHaveBeenCalledWith("NODE_START", expect.any(String), expect.any(Object));
            expect(mockObserver.onTrace).toHaveBeenCalledWith("NODE_COMPLETE", expect.any(String), expect.any(Object));
        });
    });

    describe("Transaction Tape (Recording & Replay)", () => {
        it("records state updates using the provided tapeDir", async () => {
            const node = createDynamicNode("start", testSchema.states.start, testSchema, [mockObserver]);
            const state: any = {
                _context: {},
                _stepCount: 1,
                _threadId: "record-thread",
                messages: []
            };

            await node(state);

            expect(mockStorage.write).toHaveBeenCalledWith(expect.objectContaining({
                _threadId: "record-thread",
                _stepNumber: 1
            }));
        });

        it("short-circuits execution during replay", async () => {
            (mockStorage.read as any).mockResolvedValueOnce({
                nodeName: "start",
                workflowVersion: "1.0.0",
                toolOutput: {
                    _context: { testValue: "replayed" },
                    _transitionState: "SUCCESS",
                    _stepCount: 6
                }
            });

            const state: any = {
                _context: {},
                _stepCount: 5,
                _threadId: "replay-thread",
                messages: []
            };
            const config = { configurable: { thread_id: "replay-thread", replay: true } };

            const node = createDynamicNode("start", testSchema.states.start, testSchema, [mockObserver]);
            const result = await node(state, config);

            expect(mockStorage.read).toHaveBeenCalledWith("replay-thread", 5);
            expect(result._context.testValue).toBe("replayed");
        });
    });
});
