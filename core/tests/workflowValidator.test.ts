import { getMockPath } from './utils/mockPaths.js';
import { validateSchemaIntegrity, WorkflowValidationError } from "../src/workflowValidator.js";
import { WorkflowSchema } from "../src/schemaDefinitions.js";

describe('Workflow Validator', () => {
    const validSchema: WorkflowSchema = {
        name: "TestWorkflow",
        version: "1.0.0",
        initialState: "start",
        agents: {
            gpt: { provider: "openai", model: "gpt-4" }
        },
        states: {
            "start": {
                agent: "gpt",
                action: { type: "function", path: getMockPath(import.meta.url, 'testAction.js') },
                verification: { type: "function", path: getMockPath(import.meta.url, 'testVerification.js'), expectedOutputs: ["SUCCESS", "FAILURE"] },
                stateVariables: { read: [], write: ["data"] },
                transitions: [
                    { condition: "SUCCESS", nextState: "end" },
                    { condition: "FAILURE", nextState: "__END__" }
                ]
            },
            "end": {
                action: { type: "bash", command: "echo done" },
                verification: { type: "bash", command: "exit 0", expectedOutputs: ["SUCCESS"] },
                stateVariables: { read: ["data"], write: [] },
                transitions: [
                    { condition: "SUCCESS", nextState: "__END__" },
                    { condition: "FAILURE", nextState: "__END__" }
                ]
            }
        }
    };

    it('should pass for a valid schema', () => {
        expect(() => validateSchemaIntegrity(validSchema)).not.toThrow();
    });

    it('should fail if initialState is missing from states', () => {
        const invalid = { ...validSchema, initialState: "wrong" };
        expect(() => validateSchemaIntegrity(invalid)).toThrow(WorkflowValidationError);
        expect(() => validateSchemaIntegrity(invalid)).toThrow("initialState 'wrong' is not defined");
    });

    it('should fail if a state references an undefined agent', () => {
        const invalid = JSON.parse(JSON.stringify(validSchema));
        invalid.states.start.agent = "missing";
        expect(() => validateSchemaIntegrity(invalid)).toThrow("references undefined agent 'missing'");
    });

    it('should fail if a transition points to an undefined state', () => {
        const invalid = JSON.parse(JSON.stringify(validSchema));
        invalid.states.start.transitions[0].nextState = "nowhere";
        expect(() => validateSchemaIntegrity(invalid)).toThrow("transition to undefined state 'nowhere'");
    });

    it('should fail if expectedOutputs are not covered by transitions', () => {
        const invalid = JSON.parse(JSON.stringify(validSchema));
        invalid.states.start.verification.expectedOutputs.push("MAYBE");
        expect(() => validateSchemaIntegrity(invalid)).toThrow("no specific transition is defined for it and no 'default' catch-all exists");
    });

    it('should fail if a transition condition is not declared in expectedOutputs and not a framework condition', () => {
        const invalid = JSON.parse(JSON.stringify(validSchema));
        invalid.states.start.transitions.push({ condition: "UNEXPECTED_CONDITION", nextState: "__END__" });
        expect(() => validateSchemaIntegrity(invalid)).toThrow(
            "defines transition condition 'UNEXPECTED_CONDITION', but it is not declared in its verification 'expectedOutputs'"
        );
    });

    it('should pass if a transition condition is an allowed system/framework condition', () => {
        const schemaWithSystemCond = JSON.parse(JSON.stringify(validSchema));
        schemaWithSystemCond.states.start.transitions.push({ condition: "__SUSPEND__", nextState: "__END__" });
        expect(() => validateSchemaIntegrity(schemaWithSystemCond)).not.toThrow();
    });

    it('should fail if __END__ is unreachable (DAG Verification)', () => {
        const invalid = JSON.parse(JSON.stringify(validSchema));
        // Remove transitions to __END__
        invalid.states.start.transitions = [
            { condition: "SUCCESS", nextState: "end" },
            { condition: "FAILURE", nextState: "start" }
        ];
        invalid.states.end.transitions = [
            { condition: "SUCCESS", nextState: "start" },
            { condition: "FAILURE", nextState: "start" }
        ];
        expect(() => validateSchemaIntegrity(invalid)).toThrow("DAG Verification Failed: Cannot reach '__END__'");
    });

    it('should fail if there is an inescapable infinite loop', () => {
        const invalid: WorkflowSchema = {
            name: "Loop",
            version: "1.0.0",
            initialState: "a",
            agents: {},
            states: {
                "a": {
                    action: { type: "bash", command: "ls" },
                    verification: { type: "bash", command: "ls", expectedOutputs: ["OK"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "OK", nextState: "b" },
                        { condition: "FAILURE", nextState: "a" }
                    ]
                },
                "b": {
                    action: { type: "bash", command: "ls" },
                    verification: { type: "bash", command: "ls", expectedOutputs: ["OK"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "OK", nextState: "a" },
                        { condition: "FAILURE", nextState: "b" }
                    ]
                }
            }
        };
        expect(() => validateSchemaIntegrity(invalid)).toThrow("DAG Verification Failed: Cannot reach '__END__'");
    });

    it('should pass if implicit failures are covered by a default transition', () => {
        const schemaWithDefault: WorkflowSchema = {
            name: "DefaultTest",
            version: "1.0.0",
            initialState: "start",
            agents: {},
            states: {
                "start": {
                    action: { type: "bash", command: "ls" },
                    verification: { type: "bash", command: "ls", expectedOutputs: ["OK"] },
                    stateVariables: { read: [], write: [] },
                    transitions: [
                        { condition: "default", nextState: "__END__" }
                    ]
                }
            }
        };
        expect(() => validateSchemaIntegrity(schemaWithDefault)).not.toThrow();
    });
});