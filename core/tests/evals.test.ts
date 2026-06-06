import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { runEval } from '../src/evals/evalRunner.js';

describe("Eval Runner Integration", () => {
    const tempTapeDir = path.join(process.cwd(), 'temp-eval-tapes');

    const mockSchema: any = {
        name: "TestWorkflow",
        version: "2.0.0",
        initialState: "start",
        agents: {
            "primary": { provider: "mock" }
        },
        states: {
            "start": {
                action: { type: "bash", command: "echo hello" },
                verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                stateVariables: { read: [], write: [] },
                transitions: [{ condition: "SUCCESS", nextState: "__END__" }]
            }
        }
    };

    const mockStorage = {
        read: async (threadId: string, stepCount: number) => {
            const file = path.join(tempTapeDir, threadId, `${stepCount}.json`);
            if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
            return null;
        },
        write: async (snapshot: any) => {},
        listThreads: async () => {
            if (!fs.existsSync(tempTapeDir)) return [];
            return fs.readdirSync(tempTapeDir).filter(f => fs.statSync(path.join(tempTapeDir, f)).isDirectory());
        },
        listSteps: async (threadId: string) => {
            const dir = path.join(tempTapeDir, threadId);
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => parseInt(f.replace('.json', '')));
        }
    };

    beforeAll(() => {
        if (!fs.existsSync(tempTapeDir)) fs.mkdirSync(tempTapeDir);
    });

    afterAll(() => {
        if (fs.existsSync(tempTapeDir)) fs.rmSync(tempTapeDir, { recursive: true });
    });

    it("reports a PASS when replaying identical logic", async () => {
        const threadId = "thread-1";
        const threadDir = path.join(tempTapeDir, threadId);
        if (!fs.existsSync(threadDir)) fs.mkdirSync(threadDir);

        const snapshot = {
            _threadId: "thread-1",
            _stepNumber: 0,
            nodeName: "start",
            workflowName: "TestWorkflow",
            workflowVersion: "1.0.0",
            inputState: { 
                messages: [], 
                _threadId: threadId, 
                _stepCount: 0, 
                _context: {},
                _transitionState: null
            },
            toolOutput: {
                _transitionState: "SUCCESS",
                _context: {}
            }
        };

        fs.writeFileSync(path.join(threadDir, "0.json"), JSON.stringify(snapshot));

        const results = await runEval(mockSchema, mockStorage as any);
        
        expect(results).toHaveLength(1);
        expect(results[0].passed).toBe(true);
        expect(results[0].nodeName).toBe("start");
        expect(results[0].versionAudit.tapeVersion).toBe("1.0.0");
        expect(results[0].versionAudit.schemaVersion).toBe("2.0.0");
    });

    it("reports a FAIL when verification logic changes", async () => {
        const threadId = "thread-2";
        const threadDir = path.join(tempTapeDir, threadId);
        if (!fs.existsSync(threadDir)) fs.mkdirSync(threadDir);

        const snapshot = {
            _threadId: "thread-2",
            _stepNumber: 0,
            nodeName: "start",
            workflowName: "TestWorkflow",
            workflowVersion: "1.0.0",
            inputState: { messages: [], _threadId: threadId, _stepCount: 0, _context: {} },
            toolOutput: {
                _transitionState: "FAILURE", // Tape says it failed
                _context: {}
            }
        };

        fs.writeFileSync(path.join(threadDir, "0.json"), JSON.stringify(snapshot));

        // Schema says "echo SUCCESS" which returns "SUCCESS"
        const results = await runEval(mockSchema, mockStorage as any);
        
        const res = results.find(r => r.threadId === "thread-2");
        expect(res?.passed).toBe(false);
        expect(res?.diff?.expected).toBe("FAILURE");
        expect(res?.diff?.actual).toBe("SUCCESS");
    });

    it("reports a PASS via semantic match when literal match fails", async () => {
        const { agentManager } = await import("../src/agentManager.js");
        const mockJudge = {
            invoke: jest.fn<any>().mockResolvedValue({
                content: JSON.stringify({ equivalent: true, reason: "Semantic match" })
            })
        };
        agentManager.defineAgent("judge-agent", mockJudge as any);

        const threadId = "thread-semantic";
        const threadDir = path.join(tempTapeDir, threadId);
        if (!fs.existsSync(threadDir)) fs.mkdirSync(threadDir);

        const snapshot = {
            _threadId: "thread-semantic",
            _stepNumber: 0,
            nodeName: "start",
            workflowName: "TestWorkflow",
            workflowVersion: "1.0.0",
            inputState: { messages: [], _threadId: threadId, _stepCount: 0, _context: {} },
            toolOutput: {
                _transitionState: "DIFFERENT", // Tape says DIFFERENT
                _context: { message: "Hello world" }
            }
        };

        fs.writeFileSync(path.join(threadDir, "0.json"), JSON.stringify(snapshot));

        // Actual execution will return "SUCCESS" (from schema)
        const results = await runEval(mockSchema, mockStorage as any, { judgeAgent: "judge-agent" });
        
        const res = results.find(r => r.threadId === "thread-semantic");
        expect(res?.passed).toBe(true);
        expect(res?.semanticMatch).toBe(true);
    });

    it("reports an error when node is missing in schema", async () => {
        const threadId = "thread-3";
        const threadDir = path.join(tempTapeDir, threadId);
        if (!fs.existsSync(threadDir)) fs.mkdirSync(threadDir);

        const snapshot = {
            _threadId: "thread-3",
            _stepNumber: 0,
            nodeName: "nonExistentNode",
            workflowName: "TestWorkflow",
            workflowVersion: "1.0.0",
            inputState: { messages: [], _threadId: threadId, _stepCount: 0, _context: {} },
            toolOutput: { _transitionState: "SUCCESS", _context: {} }
        };

        fs.writeFileSync(path.join(threadDir, "0.json"), JSON.stringify(snapshot));

        const results = await runEval(mockSchema, mockStorage as any);
        
        const res = results.find(r => r.threadId === "thread-3");
        expect(res?.passed).toBe(false);
        expect(res?.error).toContain("not found in current schema");
    });
});
