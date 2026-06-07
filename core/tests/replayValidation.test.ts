import { jest } from '@jest/globals';
import { getMockPath } from './utils/mockPaths.js';
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// 1. Setup mocks
const mockStorage = {
    write: jest.fn<any>().mockResolvedValue(undefined),
    read: jest.fn<any>(),
    listThreads: jest.fn<any>(),
    listSteps: jest.fn<any>()
};

// Mock readline module
const mockQuestion = jest.fn<any>();
const mockClose = jest.fn<any>();
jest.unstable_mockModule('node:readline/promises', () => {
    return {
        default: {
            createInterface: jest.fn().mockImplementation(() => {
                return {
                    question: mockQuestion,
                    close: mockClose
                };
            })
        }
    };
});

// Import Engine and node factory components
const { compileWorkflow } = await import("../src/engine.js");
const { calculateHashesForState } = await import("../src/cryptoLedger.js");

const testSchema: any = {
    name: "ReplayValidationTest",
    version: "1.0.0",
    initialState: "start",
    settings: {
        tapeDir: "test-tapes",
        storage: mockStorage
    },
    agents: {},
    states: {
        "start": {
            action: { type: "function", path: getMockPath(import.meta.url, 'testAction.js') },
            verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: [
                { condition: "SUCCESS", nextState: "__END__" }
            ]
        }
    }
};

describe("Robust Replay Validation", () => {
    let originalIsTTY: boolean | undefined;
    let originalCI: string | undefined;

    beforeEach(() => {
        jest.clearAllMocks();
        originalIsTTY = process.stdin.isTTY;
        originalCI = process.env.CI;
    });

    afterEach(() => {
        if (originalIsTTY === undefined) delete (process.stdin as any).isTTY;
        else process.stdin.isTTY = originalIsTTY;
        if (originalCI === undefined) delete process.env.CI;
        else process.env.CI = originalCI;
    });

    describe("Deterministic Workflow Hashing", () => {
        it("should produce the same hash regardless of the key order in the schema", async () => {
            const schema1 = { ...testSchema };
            const schema2 = {
                version: "1.0.0",
                initialState: "start",
                name: "ReplayValidationTest",
                agents: {},
                settings: {
                    storage: mockStorage,
                    tapeDir: "test-tapes"
                },
                states: {
                    "start": {
                        action: { path: getMockPath(import.meta.url, 'testAction.js'), type: "function" },
                        verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS"] },
                        stateVariables: { write: [], read: [] },
                        transitions: [
                            { condition: "SUCCESS", nextState: "__END__" }
                        ]
                    }
                }
            };

            const cwd = process.cwd();
            const hashes1 = await calculateHashesForState("start", schema1 as any, cwd);
            const hashes2 = await calculateHashesForState("start", schema2 as any, cwd);

            expect(hashes1.workflowHash).toBe(hashes2.workflowHash);
        });
    });

    describe("Non-interactive / CI Safeguards", () => {
        it("should throw an error safely in non-interactive environments when drift is detected", async () => {
            // Force non-interactive / CI environment
            process.stdin.isTTY = false;
            process.env.CI = "true";

            // Mock reading an older tape with a different workflow structure hash
            mockStorage.read.mockResolvedValueOnce({
                nodeName: "start",
                workflowVersion: "1.0.0",
                hashes: {
                    workflowHash: "different-workflow-hash",
                    actionHash: "different-action-hash"
                },
                toolOutput: {
                    _context: {},
                    _transitionState: "SUCCESS",
                    _stepCount: 1
                }
            });

            const agent = compileWorkflow(testSchema, []);
            const state: any = {
                _context: {},
                _stepCount: 0,
                _threadId: "test-ci-drift-thread",
                messages: []
            };

            const config = { configurable: { thread_id: "test-ci-drift-thread", replay: true } };

            await expect(agent.invoke(state, config)).rejects.toThrow(
                /Chronicle AI Replay Error: Workflow drift or WASM warning detected/
            );
        });

        it("should throw an error when WASM is not enabled for bash action in non-interactive environment during replay", async () => {
            process.stdin.isTTY = false;
            process.env.CI = "true";

            const unsandboxedSchema = {
                ...testSchema,
                states: {
                    start: {
                        action: { type: "bash", command: "echo unsandboxed" },
                        verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                        stateVariables: { read: [], write: [] },
                        transitions: [{ condition: "SUCCESS", nextState: "__END__" }]
                    }
                }
            };

            const cwd = process.cwd();
            const hashes = await calculateHashesForState("start", unsandboxedSchema as any, cwd);

            mockStorage.read.mockResolvedValueOnce({
                nodeName: "start",
                workflowVersion: "1.0.0",
                hashes,
                toolOutput: {
                    _context: {},
                    _transitionState: "SUCCESS",
                    _stepCount: 1
                }
            });

            const agent = compileWorkflow(unsandboxedSchema as any, []);
            const state: any = {
                _context: {},
                _stepCount: 0,
                _threadId: "test-ci-wasm-thread",
                messages: []
            };

            const config = { configurable: { thread_id: "test-ci-wasm-thread", replay: true } };

            await expect(agent.invoke(state, config)).rejects.toThrow(
                /Warning: WASM is not enabled/
            );
        });
    });

    describe("Interactive Environments", () => {
        it("should prompt user via readline and continue replay if they input 'Y' or 'yes'", async () => {
            // Force interactive environment
            process.stdin.isTTY = true;
            delete process.env.CI;

            // Mock reading an older tape with drift
            mockStorage.read.mockResolvedValueOnce({
                nodeName: "start",
                workflowVersion: "1.0.0",
                hashes: {
                    workflowHash: "different-workflow-hash",
                    actionHash: "different-action-hash"
                },
                toolOutput: {
                    _context: {},
                    _transitionState: "SUCCESS",
                    _stepCount: 1
                }
            });

            // Simulate user choosing to continue by typing "yes"
            mockQuestion.mockResolvedValue("yes");

            const agent = compileWorkflow(testSchema, []);
            const state: any = {
                _context: {},
                _stepCount: 0,
                _threadId: "test-interactive-continue-thread",
                messages: []
            };

            const config = { configurable: { thread_id: "test-interactive-continue-thread", replay: true } };

            const result = await agent.invoke(state, config);
            expect(result._stepCount).toBe(1);
            expect(mockQuestion).toHaveBeenCalled();
        });

        it("should prompt user via readline and abort if they input anything else", async () => {
            // Force interactive environment
            process.stdin.isTTY = true;
            delete process.env.CI;

            // Mock reading an older tape with drift
            mockStorage.read.mockResolvedValueOnce({
                nodeName: "start",
                workflowVersion: "1.0.0",
                hashes: {
                    workflowHash: "different-workflow-hash",
                    actionHash: "different-action-hash"
                },
                toolOutput: {
                    _context: {},
                    _transitionState: "SUCCESS",
                    _stepCount: 1
                }
            });

            // Simulate user choosing NOT to continue by typing "no"
            mockQuestion.mockResolvedValue("no");

            const agent = compileWorkflow(testSchema, []);
            const state: any = {
                _context: {},
                _stepCount: 0,
                _threadId: "test-interactive-abort-thread",
                messages: []
            };

            const config = { configurable: { thread_id: "test-interactive-abort-thread", replay: true } };

            await expect(agent.invoke(state, config)).rejects.toThrow(
                /Replay aborted by user/
            );
            expect(mockQuestion).toHaveBeenCalled();
        });

        it("should bypass warnings if bypassReplayValidation configuration is enabled", async () => {
            process.stdin.isTTY = true;
            delete process.env.CI;

            mockStorage.read.mockResolvedValueOnce({
                nodeName: "start",
                workflowVersion: "1.0.0",
                hashes: {
                    workflowHash: "different-workflow-hash",
                    actionHash: "different-action-hash"
                },
                toolOutput: {
                    _context: {},
                    _transitionState: "SUCCESS",
                    _stepCount: 1
                }
            });

            const agent = compileWorkflow(testSchema, []);
            const state: any = {
                _context: {},
                _stepCount: 0,
                _threadId: "test-bypass-thread",
                messages: []
            };

            // Enable bypassReplayValidation in the configurable object
            const config = {
                configurable: {
                    thread_id: "test-bypass-thread",
                    replay: true,
                    bypassReplayValidation: true
                }
            };

            const result = await agent.invoke(state, config);
            expect(result._stepCount).toBe(1);
            expect(mockQuestion).not.toHaveBeenCalled();
        });
    });
});
