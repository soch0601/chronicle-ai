import { WorkflowSchema } from "./schemaDefinitions.js";

export class WorkflowValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkflowValidationError";
    }
}

/**
 * Validates a raw JSON string against the WorkflowSchema integrity rules.
 */
export function validateWorkflowSchema(rawData: string): WorkflowSchema {
    if (!rawData) {
        throw new WorkflowValidationError("Workflow JSON is empty.");
    }

    let schema: WorkflowSchema;
    try {
        schema = JSON.parse(rawData);
    } catch (err: any) {
        throw new WorkflowValidationError(`Failed to parse workflow JSON: ${err.message}`);
    }

    validateSchemaIntegrity(schema);
    return schema;
}

/**
 * Orchestrates the full validation of the workflow schema.
 */
export function validateSchemaIntegrity(schema: WorkflowSchema) {
    validateBasicStructure(schema);
    validateNodes(schema);
    validateStateVariables(schema);
    validateDAG(schema);
}

/**
 * Checks for existence of states and initial state.
 */
function validateBasicStructure(schema: WorkflowSchema) {
    if (!schema.states || Object.keys(schema.states).length === 0) {
        throw new WorkflowValidationError("Workflow must define at least one state.");
    }

    if (!schema.initialState) {
        throw new WorkflowValidationError("Workflow must define an initialState.");
    }

    if (!schema.states[schema.initialState]) {
        throw new WorkflowValidationError(`initialState '${schema.initialState}' is not defined in the states object.`);
    }
}

/**
 * Validates individual nodes: agents, verification outputs, transitions, and expected outputs contract coverage.
 */
function validateNodes(schema: WorkflowSchema) {
    for (const [stateName, stateDef] of Object.entries(schema.states)) {
        // 1. Agent Validation
        if (stateDef.agent && (!schema.agents || !schema.agents[stateDef.agent])) {
            throw new WorkflowValidationError(`State '${stateName}' references undefined agent '${stateDef.agent}'.`);
        }

        // Sandboxed Action/Verification Validation
        const action = stateDef.action;
        if (action?.sandboxed) {
            if (action.type !== "bash") {
                throw new WorkflowValidationError(`State '${stateName}' action has 'sandboxed' set to true, but only 'bash' type actions support sandboxing.`);
            }
            if (action.sandboxFiles && !Array.isArray(action.sandboxFiles)) {
                throw new WorkflowValidationError(`State '${stateName}' action 'sandboxFiles' must be an array of strings.`);
            }
            if (action.sandboxEnv && !Array.isArray(action.sandboxEnv)) {
                throw new WorkflowValidationError(`State '${stateName}' action 'sandboxEnv' must be an array of strings.`);
            }
        }
        const verification = stateDef.verification;
        if (verification?.sandboxed) {
            if (verification.type !== "bash") {
                throw new WorkflowValidationError(`State '${stateName}' verification has 'sandboxed' set to true, but only 'bash' type verifications support sandboxing.`);
            }
            if (verification.sandboxFiles && !Array.isArray(verification.sandboxFiles)) {
                throw new WorkflowValidationError(`State '${stateName}' verification 'sandboxFiles' must be an array of strings.`);
            }
            if (verification.sandboxEnv && !Array.isArray(verification.sandboxEnv)) {
                throw new WorkflowValidationError(`State '${stateName}' verification 'sandboxEnv' must be an array of strings.`);
            }
        }

        // 2. Verification Integrity
        const expectedOutputs = stateDef.verification?.expectedOutputs || [];
        if (expectedOutputs.length === 0) {
            throw new WorkflowValidationError(`State '${stateName}' must define 'expectedOutputs' in its verification block.`);
        }

        // 3. Transition Coverage
        const transitionConditions = new Set(stateDef.transitions?.map(t => t.condition) || []);
        const hasDefault = transitionConditions.has("default") || transitionConditions.has("*");

        // A. Ensure all expected verification outputs have transitions defined
        for (const expected of expectedOutputs) {
            if (!transitionConditions.has(expected) && !hasDefault) {
                throw new WorkflowValidationError(`State '${stateName}' expects output '${expected}', but no specific transition is defined for it and no 'default' catch-all exists.`);
            }
        }

        // B. Strict Inverse Check: Ensure transitions don't match undeclared/phantom outputs
        const allowedSystemConditions = new Set(["default", "*", "FAILURE", "VALIDATION_ERROR", "REJECTED", "__SUSPEND__"]);
        for (const t of stateDef.transitions || []) {
            if (!expectedOutputs.includes(t.condition) && !allowedSystemConditions.has(t.condition)) {
                throw new WorkflowValidationError(
                    `State '${stateName}' defines transition condition '${t.condition}', but it is not declared in its verification 'expectedOutputs' [${expectedOutputs.join(", ")}] and is not a reserved framework condition.`
                );
            }
        }

        // 4. Transition Targets
        for (const t of stateDef.transitions || []) {
            if (t.nextState !== "__END__" && !schema.states[t.nextState]) {
                throw new WorkflowValidationError(`State '${stateName}' defines a transition to undefined state '${t.nextState}'.`);
            }
        }

        // 5. Implicit Framework Transition Coverage
        // Check for FAILURE (Bash or generic execution error)
        const canFail = stateDef.action.type === "bash" || stateDef.action.type === "workflow" || stateDef.verification?.type === "bash";
        if (canFail && !transitionConditions.has("FAILURE") && !hasDefault) {
            throw new WorkflowValidationError(`State '${stateName}' uses Bash components which can fail, but no transition is defined for condition 'FAILURE' and no 'default' exists.`);
        }

        // Check for VALIDATION_ERROR
        if (stateDef.outputSchema && !transitionConditions.has("VALIDATION_ERROR") && !hasDefault) {
            throw new WorkflowValidationError(`State '${stateName}' defines an 'outputSchema', but no transition is defined for condition 'VALIDATION_ERROR' and no 'default' exists.`);
        }

        // Check for REJECTED (HITL Approval)
        if (stateDef.action?.requiresApproval && !transitionConditions.has("REJECTED") && !hasDefault) {
            throw new WorkflowValidationError(`State '${stateName}' requires human approval, but no transition is defined for condition 'REJECTED' and no 'default' exists.`);
        }
    }
}

/**
 * Ensures user-defined state variables do not collide with framework-reserved ones (which start with '_').
 */
function validateStateVariables(schema: WorkflowSchema) {
    for (const [stateName, stateDef] of Object.entries(schema.states)) {
        if (!stateDef.stateVariables) continue;

        const allVars = [...(stateDef.stateVariables.read || []), ...(stateDef.stateVariables.write || [])];
        for (const varName of allVars) {
            if (varName.startsWith('_')) {
                throw new WorkflowValidationError(`State '${stateName}' defines variable '${varName}'. Variables starting with '_' are reserved for the framework.`);
            }
        }
    }
}

/**
 * Performs reachability analysis to ensure the graph is valid and has an exit.
 */
function validateDAG(schema: WorkflowSchema) {
    const visited = new Set<string>();
    const memo = new Map<string, boolean>();

    function canReachEnd(nodeName: string): boolean {
        if (nodeName === "__END__") return true;
        if (!schema.states[nodeName]) return false;
        if (memo.has(nodeName)) return memo.get(nodeName)!;
        if (visited.has(nodeName)) return false; // Cycle detected

        visited.add(nodeName);
        const stateDef = schema.states[nodeName];
        let reachable = false;

        if (stateDef.transitions) {
            for (const t of stateDef.transitions) {
                if (canReachEnd(t.nextState)) {
                    reachable = true;
                    break;
                }
            }
        }

        visited.delete(nodeName);
        memo.set(nodeName, reachable);
        return reachable;
    }

    if (!canReachEnd(schema.initialState)) {
        throw new WorkflowValidationError(`DAG Verification Failed: Cannot reach '__END__' from initialState '${schema.initialState}'.`);
    }
}