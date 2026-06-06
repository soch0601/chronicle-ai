import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { jest } from '@jest/globals';

const execAsync = promisify(exec);

describe("Eval Runner CLI Integration", () => {
    const tempDir = path.join(process.cwd(), 'temp-integration-evals');
    const schemaPath = path.join(tempDir, 'schema.json');
    const tapeDir = path.join(tempDir, 'tapes');
    const threadDir = path.join(tapeDir, 'thread-cli');

    beforeAll(() => {
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        if (!fs.existsSync(tapeDir)) fs.mkdirSync(tapeDir);
        if (!fs.existsSync(threadDir)) fs.mkdirSync(threadDir);

        // 1. Write Mock Schema
        const schema = {
            name: "IntegrationEvalWorkflow",
            version: "1.0.0",
            initialState: "start",
            states: {
                "start": {
                    action: { type: "bash", command: "echo hello" },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [{ condition: "SUCCESS", nextState: "__END__" }]
                }
            }
        };
        fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

        // 2. Write Mock Tape
        const snapshot = {
            _threadId: "thread-cli",
            _stepNumber: 0,
            nodeName: "start",
            workflowName: "IntegrationEvalWorkflow",
            workflowVersion: "1.0.0",
            inputState: { messages: [], _threadId: "thread-cli", _stepCount: 0, _context: {} },
            toolOutput: { _transitionState: "SUCCESS", _context: {} }
        };
        fs.writeFileSync(path.join(threadDir, "0.json"), JSON.stringify(snapshot, null, 2));
    });

    afterAll(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("successfully runs the CLI command and evaluates the tape", async () => {
        // Run the eval CLI
        const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/scripts/runEvals.ts');
        
        // We use npx tsx to execute the typescript file just like in package.json
        const { stdout } = await execAsync(`npx tsx ${scriptPath} --schema=${schemaPath} --tapeDir=${tapeDir}`);

        expect(stdout).toContain("Starting Industrial Eval Runner");
        expect(stdout).toContain("IntegrationEvalWorkflow");
        expect(stdout).toContain("✅ PASS | thread-cli | start");
        expect(stdout).toContain("1 Passed, 0 Failed");
    }, 15000); // Allow time for tsx to boot
});
