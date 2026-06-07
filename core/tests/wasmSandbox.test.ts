import { jest } from '@jest/globals';
import { AgentStateType } from "../src/schema.js";
import { StateDefinition, WorkflowSchema } from "../src/schemaDefinitions.js";
import fs from "fs/promises";
import path from "path";

// Define mock functions for Wasmer SDK
const mockWriteFile = jest.fn<any>().mockResolvedValue(undefined);
const mockCreateDir = jest.fn<any>().mockResolvedValue(undefined);
const mockRun = jest.fn<any>().mockResolvedValue({
    wait: jest.fn<any>().mockResolvedValue({
        stdout: "Mocked stdout output\n",
        stderr: "",
        code: 0
    })
});
const mockInit = jest.fn<any>().mockResolvedValue(undefined);
const mockFromRegistry = jest.fn<any>().mockResolvedValue({
    entrypoint: {
        run: mockRun
    }
});

// Mock the @wasmer/sdk module
await jest.unstable_mockModule('@wasmer/sdk', () => {
    return {
        init: mockInit,
        Directory: jest.fn().mockImplementation(() => {
            return {
                writeFile: mockWriteFile,
                createDir: mockCreateDir
            };
        }),
        Wasmer: {
            fromRegistry: mockFromRegistry
        }
    };
});

// Import createDynamicNode and ChronicleEngine after mocking @wasmer/sdk
const { createDynamicNode, warmupWasm, resetWasmCache } = await import("../src/nodeFactory.js");
const { ChronicleEngine } = await import("../src/engine.js");

describe('WASM Sandboxing', () => {
    const mockWorkflow: WorkflowSchema = {
        name: "TestSandbox",
        version: "1.0.0",
        initialState: "start",
        agents: {},
        states: {}
    };

    const mockState: any = {
        _context: {},
        _stepCount: 0,
        _threadId: "test-thread",
        _maxCycles: 3,
        _cycleCount: {},
        messages: []
    };

    beforeEach(() => {
        jest.clearAllMocks();
        resetWasmCache();
    });

    it('should pre-warm the sandbox cache when warmupWasm is called', async () => {
        await warmupWasm();
        expect(mockInit).toHaveBeenCalled();
        expect(mockFromRegistry).toHaveBeenCalledWith("sharrattj/bash");

        // Clear mocks and run execution to verify it uses the warmed cache
        mockInit.mockClear();
        mockFromRegistry.mockClear();

        const stateDef: StateDefinition = {
            action: { 
                type: "bash", 
                command: "echo 'Warmup Test'", 
                sandboxed: true 
            },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: []
        };

        const node = createDynamicNode("sandboxWarmupState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("SUCCESS");
        // Ensure no new network initialization/fetches occur because it was pre-warmed
        expect(mockInit).not.toHaveBeenCalled();
        expect(mockFromRegistry).not.toHaveBeenCalled();
    });

    it('should run a simple echo command inside the sandbox', async () => {
        const stateDef: StateDefinition = {
            action: {
                type: "bash",
                command: "echo 'Hello WASM Sandbox'",
                sandboxed: true
            },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: ["lastStdout"] },
            transitions: []
        };

        const node = createDynamicNode("sandboxEchoState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("SUCCESS");
        expect(mockInit).toHaveBeenCalled();
        expect(mockFromRegistry).toHaveBeenCalledWith("sharrattj/bash");
        expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({
            args: ["-c", "echo 'Hello WASM Sandbox'"],
            mount: expect.objectContaining({
                '/': expect.any(Object)
            })
        }));
    });

    it('should mount files and propagate environment variables inside the sandbox', async () => {
        // Create a temporary file to mount
        const tempFileName = "temp_test_sandbox_file.txt";
        const tempFilePath = path.resolve(process.cwd(), tempFileName);
        await fs.writeFile(tempFilePath, "Content of sandbox file");

        process.env.SANDBOX_TEST_VAR = "VarsFromHost";

        const stateDef: StateDefinition = {
            action: {
                type: "bash",
                command: `cat ${tempFileName} && echo "EnvVar=$SANDBOX_TEST_VAR"`,
                sandboxed: true,
                sandboxFiles: [tempFileName],
                sandboxEnv: ["SANDBOX_TEST_VAR"]
            },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: []
        };

        const node = createDynamicNode("sandboxMountState", stateDef, mockWorkflow);

        try {
            const result = await node(mockState as AgentStateType);
            expect(result._transitionState).toBe("SUCCESS");

            // Verify environment variables were passed
            expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({
                env: expect.objectContaining({
                    SANDBOX_TEST_VAR: "VarsFromHost"
                })
            }));

            // Verify file was mounted with binary serialization array matchers
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.stringContaining(tempFileName),
                expect.any(Uint8Array)
            );
        } finally {
            // Clean up temporary file
            await fs.unlink(tempFilePath).catch(() => { });
            delete process.env.SANDBOX_TEST_VAR;
        }
    });

    it('should run natively on the host when sandboxed is false', async () => {
        const stateDef: StateDefinition = {
            action: {
                type: "bash",
                command: "echo 'Host Execution'",
                sandboxed: false
            },
            verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: [] },
            transitions: []
        };

        const node = createDynamicNode("hostEchoState", stateDef, mockWorkflow);
        const result = await node(mockState as AgentStateType);

        expect(result._transitionState).toBe("SUCCESS");
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('should support ChronicleEngine class wrapper for compiling, warming, and executing workflows', async () => {
        const schema: WorkflowSchema = {
            name: "EngineWorkflow",
            version: "1.0.0",
            initialState: "stateA",
            agents: {},
            states: {
                stateA: {
                    action: { type: "bash", command: "echo A", sandboxed: true },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" }
                    ]
                }
            }
        };

        const engine = new ChronicleEngine(schema);
        await engine.warmup();

        expect(mockInit).toHaveBeenCalled();
        expect(mockFromRegistry).toHaveBeenCalledWith("sharrattj/bash");

        mockInit.mockClear();
        mockFromRegistry.mockClear();

        const result = await engine.execute(mockState, { configurable: { thread_id: "test-thread" } });
        expect(result._transitionState).toBe("SUCCESS");
        expect(mockInit).not.toHaveBeenCalled();
        expect(mockFromRegistry).not.toHaveBeenCalled();
    });
});