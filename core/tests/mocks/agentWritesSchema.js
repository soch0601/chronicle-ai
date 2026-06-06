import fs from 'fs';
import path from 'path';

export async function run(state) {
    const tempPath = path.join(process.cwd(), 'dynamic-integration-test.json');
    
    const dynamicSchema = {
        name: "DynamicIntegrationSubWorkflow",
        version: "1.0.0",
        initialState: "doWork",
        agents: {},
        states: {
            "doWork": {
                action: { type: "bash", command: "echo INTEGRATION_WORK_DONE" },
                verification: { type: "bash", command: "echo SUCCESS", expectedOutputs: ["SUCCESS"] },
                stateVariables: { read: [], write: ["dynamicOutput"] },
                transitions: [
                    { condition: "SUCCESS", nextState: "__END__" },
                    { condition: "FAILURE", nextState: "__END__" }
                ]
            }
        }
    };

    fs.writeFileSync(tempPath, JSON.stringify(dynamicSchema, null, 2));

    return {
        _transitionState: "SUCCESS",
        _context: {
            dynamicPath: tempPath
        }
    };
}
