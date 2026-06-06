import { getMockPath } from '../utils/mockPaths.js';
import fs from 'fs';
import path from 'path';
import { createWorkflowGraph } from '../../src/index.js';
import { WorkflowSchema } from '../../src/schemaDefinitions.js';

describe("Dynamic Workflow Integration", () => {
    const tempPath = path.join(process.cwd(), 'dynamic-integration-test.json');

    afterAll(() => {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
    });

    it("simulates an AI agent generating a workflow schema to disk and seamlessly executing it", async () => {
        // 1. The parent schema
        // State 1: A function that simulates an AI agent writing a workflow JSON file to disk
        // State 2: A workflow action that uses dynamicPathKey to read that file and run it
        const parentSchema: WorkflowSchema = {
            name: "ParentIntegrationWorkflow",
            version: "1.0.0",
            initialState: "agentResearch",
            agents: {},
            states: {
                "agentResearch": {
                    action: { type: "function", path: getMockPath(import.meta.url, 'agentWritesSchema.js') },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: ["dynamicPath"] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "runGenerated" },
                        { condition: "FAILURE", nextState: "__END__" }
                    ]
                },
                "runGenerated": {
                    action: { type: "workflow", dynamicPathKey: "dynamicPath" },
                    verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: ["dynamicPath"], write: [] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" },
                        { condition: "FAILURE", nextState: "__END__" }
                    ]
                }
            }
        };

        const workflow = createWorkflowGraph(parentSchema, []);
        const app = workflow.compile();

        const result = await app.invoke({
            messages: [],
            _stepCount: 0,
            _maxSteps: 15,
            _threadId: "integration-thread",
            _context: {}
        }, { configurable: { thread_id: "integration-thread" } });

        // 2. Assertions
        // The first node should have created the file
        expect(fs.existsSync(tempPath)).toBe(true);
        
        // The second node should have successfully executed the subworkflow
        expect(result._currentStateId).toBe("runGenerated");
        expect(result._transitionState).toBe("SUCCESS");
        expect(result._context.dynamicPath).toBe(tempPath);
    });
});
