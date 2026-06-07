import { getMockPath } from './utils/mockPaths.js';
import { jest } from '@jest/globals';

// 1. Setup Framework Mocks
await jest.unstable_mockModule('../src/dataReplay.js', () => ({
    writeState: jest.fn(),
    readState: jest.fn()
}));

// 2. Import Framework Core
const { createWorkflowGraph } = await import("../src/engine.js");

const testParentSchema: any = {
    name: "ParentWorkflow",
    version: "1.0.0",
    initialState: "callSubworkflow",
    settings: {
        tapeDir: "test-tapes"
    },
    agents: {},
    states: {
        "callSubworkflow": {
            action: { type: "workflow", path: getMockPath(import.meta.url, 'subworkflow.json') },
            verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS"] },
            stateVariables: { read: [], write: ["testValue"] }, // The subworkflow final state will be merged into parent context
            transitions: [
                { condition: "SUCCESS", nextState: "__END__" },
                { condition: "FAILURE", nextState: "__END__" }
            ]
        }
    }
};

import fs from 'fs';
import path from 'path';

let tempSubworkflowPath: string;

describe("Subworkflow Integration", () => {
    beforeAll(() => {
        tempSubworkflowPath = path.join(process.cwd(), 'temp_subworkflow.json');
        const schema = {
            name: "SubWorkflow",
            version: "1.0.0",
            initialState: "start",
            agents: {},
            states: {
                "start": {
                    action: { type: "function", path: getMockPath(import.meta.url, 'testAction.js') },
                    verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS"] },
                    stateVariables: { read: [], write: ["testValue"] },
                    transitions: [
                        { condition: "SUCCESS", nextState: "__END__" }
                    ]
                }
            }
        };
        fs.writeFileSync(tempSubworkflowPath, JSON.stringify(schema, null, 2));

        testParentSchema.states.callSubworkflow.action.path = tempSubworkflowPath;
    });

    afterAll(() => {
        if (fs.existsSync(tempSubworkflowPath)) {
            fs.unlinkSync(tempSubworkflowPath);
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("executes a subworkflow as a node and merges its state", async () => {
        const workflow = createWorkflowGraph(testParentSchema, []);
        const app = workflow.compile();

        const initialState = {
            messages: [],
            _stepCount: 0,
            _maxSteps: 15,
            _threadId: "parent-thread",
            _context: {}
        };

        const result = await app.invoke(initialState);
        if (result._transitionState === "FAILURE") {
            console.error(result._transitionReason);
            console.error(result._context.lastError);
        }
        
        expect(result._context.testValue).toBe("completed");
    });
});
