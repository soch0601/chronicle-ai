import fs from 'fs';
import path from 'path';
import { compileWorkflow } from '../src/engine.js';
import { WorkflowSchema } from '../src/schemaDefinitions.js';

describe("Dynamic Workflow Execution", () => {
    const tempDir = path.join(process.cwd(), 'temp-dynamic-workflows');
    const validSchemaPath = path.join(tempDir, 'valid.json');
    const invalidSchemaPath = path.join(tempDir, 'invalid.json');

    beforeAll(() => {
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        // 1. Write a VALID dynamic sub-workflow
        const validSchema: WorkflowSchema = {
            name: "ValidDynamicSubWorkflow",
            version: "1.0.0",
            initialState: "start",
            agents: {},
            states: {
                "start": {
                    action: { type: "bash", command: "echo DYNAMIC_SUCCESS" },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" },
                        { condition: "FAILURE", nextState: "__END__" }
                    ]
                }
            }
        };
        fs.writeFileSync(validSchemaPath, JSON.stringify(validSchema, null, 2));

        // 2. Write an INVALID dynamic sub-workflow (missing transitions)
        const invalidSchema: any = {
            name: "InvalidDynamicSubWorkflow",
            version: "1.0.0",
            initialState: "start",
            agents: {},
            states: {
                "start": {
                    action: { type: "bash", command: "echo DYNAMIC_FAIL" },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: [] }
                    // Missing transitions!
                }
            }
        };
        fs.writeFileSync(invalidSchemaPath, JSON.stringify(invalidSchema, null, 2));
    });

    afterAll(() => {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("successfully runs a dynamic workflow defined by a path in the state", async () => {
        const parentSchema: WorkflowSchema = {
            name: "ParentWorkflow",
            version: "1.0.0",
            initialState: "runDynamic",
            agents: {},
            states: {
                "runDynamic": {
                    action: { type: "workflow", dynamicPathKey: "generatedPlan" },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: ["generatedPlan"], write: [] },
                    transitions: [{ condition: "SUCCESS", nextState: "__END__" }]
                }
            }
        };

        const app = compileWorkflow(parentSchema);

        const result = await app.invoke({
            messages: [],
            _stepCount: 0,
            _context: {
                generatedPlan: validSchemaPath
            }
        }, { configurable: { thread_id: "valid-thread" } });

        // It should complete successfully
        expect(result._transitionState).toBe("SUCCESS");
        expect(result._currentStateId).toBe("runDynamic");
    });

    it("returns FAILURE when a dynamic workflow path is invalid", async () => {
        const parentSchema: WorkflowSchema = {
            name: "ParentWorkflow",
            version: "1.0.0",
            initialState: "runDynamic",
            agents: {},
            states: {
                "runDynamic": {
                    action: { type: "workflow", dynamicPathKey: "generatedPlan" },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: ["generatedPlan"], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" },
                        { condition: "FAILURE", nextState: "__END__" }
                    ]
                }
            }
        };

        const app = compileWorkflow(parentSchema);

        const result = await app.invoke({
            messages: [],
            _stepCount: 0,
            _context: {
                generatedPlan: invalidSchemaPath
            }
        }, { configurable: { thread_id: "invalid-thread" } });

        // It should catch the validation error and return FAILURE early exit
        expect(result._transitionState).toBe("FAILURE");
        expect(result._currentStateId).toBe("runDynamic");
        expect(result._context.lastError).toContain("no specific transition is defined for it");
    });

    it("returns FAILURE when dynamic workflow file is completely missing", async () => {
        const parentSchema: WorkflowSchema = {
            name: "ParentWorkflow",
            version: "1.0.0",
            initialState: "runDynamic",
            agents: {},
            states: {
                "runDynamic": {
                    action: { type: "workflow", dynamicPathKey: "generatedPlan" },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: ["generatedPlan"], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" },
                        { condition: "FAILURE", nextState: "__END__" }
                    ]
                }
            }
        };

        const app = compileWorkflow(parentSchema);

        const result = await app.invoke({
            messages: [],
            _stepCount: 0,
            _context: {
                generatedPlan: path.join(tempDir, "does-not-exist.json")
            }
        }, { configurable: { thread_id: "missing-thread" } });

        // It should catch the missing file error
        expect(result._transitionState).toBe("FAILURE");
        expect(result._currentStateId).toBe("runDynamic");
        expect(result._context.lastError).toContain("Failed to read workflow schema");
    });
});
