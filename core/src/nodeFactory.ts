import { AgentStateType } from "./schema.js";
import { StateDefinition, WorkflowSchema, ActionDefinition } from "./schemaDefinitions.js";
import { agentManager } from "./agentManager.js";
import { toolRegistry } from "./toolRegistry.js";
import { WorkflowObserver } from "./observer.js";
import { compileWorkflow } from "./engine.js";
import { validateWorkflowSchema } from "./workflowValidator.js";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { TokenUsage } from "./schema.js";
export { warmupWasm, resetWasmCache } from "./wasmSandbox.js";
import { executeSandboxedBash } from "./wasmSandbox.js";
import { handleReplay, handleRecording } from "./cryptoLedger.js";


const actionCache = new Map<string, any>();



/**
 * A statechart-specific phase boundary gate to manage internal deadline boundaries.
 */
class PhaseBoundaryGate {
    private epochLimit: number;

    constructor(config: { epochLimit: number }) {
        this.epochLimit = config.epochLimit;
    }

    async intercept<T>(
        lifecycleToken: string,
        operation: (boundaryGate: AbortSignal) => Promise<T>,
        parentGate?: AbortSignal
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort(`Timeout: ${lifecycleToken} exceeded ${this.epochLimit}ms limit.`);
                reject(new Error(`Timeout: ${lifecycleToken} exceeded ${this.epochLimit}ms limit.`));
            }, this.epochLimit);

            if (timeoutId.unref) {
                timeoutId.unref();
            }

            const onParentAbort = () => {
                clearTimeout(timeoutId);
                controller.abort("Parent workflow aborted");
                reject(new Error(`Workflow aborted.`));
            };

            if (parentGate) {
                if (parentGate.aborted) return onParentAbort();
                parentGate.addEventListener('abort', onParentAbort);
            }

            operation(controller.signal).then(val => {
                clearTimeout(timeoutId);
                if (parentGate) parentGate.removeEventListener('abort', onParentAbort);
                resolve(val);
            }).catch(err => {
                clearTimeout(timeoutId);
                if (parentGate) parentGate.removeEventListener('abort', onParentAbort);
                reject(err);
            });
        });
    }
}

/**
 * Creates a dynamic LangGraph node from a state definition.
 */
export function createDynamicNode(
    stateName: string,
    stateDef: StateDefinition,
    workflow: WorkflowSchema,
    observers: WorkflowObserver[] = []
) {
    return async (state: AgentStateType, config: any = {}) => {
        observers.forEach(o => o.onNodeStart?.(stateName, state));
        const trace = createTracer(stateName, state._threadId, observers);

        // 1. Replay Logic
        const replayResult = await handleReplay(stateName, state, config, workflow, trace);
        if (replayResult) return replayResult;

        trace("NODE_START", `Executing dynamic state: ${stateName}`);

        // 🛡️ 1b. DYNAMIC CYCLE CIRCUIT BREAKER ENGINE
        let activeCycleMap = state._cycleCount ? { ...state._cycleCount } : {};
        const isHitlGate = !!stateDef.hitl || stateDef.action?.requiresApproval === true;

        if (isHitlGate) {
            trace("CYCLE_GUARD_RESET", `Human-In-The-Loop gate hit at [${stateName}]. Resetting autonomous tracking window.`);
            activeCycleMap = {};
        } else {
            // Increment visitation count on our isolated copy
            activeCycleMap[stateName] = (activeCycleMap[stateName] || 0) + 1;
            const maxCyclesAllowed = state._maxCycles || 3;

            // If we are in a hard stuck cycle with no HITL interaction, terminate it
            if (activeCycleMap[stateName] > maxCyclesAllowed) {
                trace("CYCLE_BREAKER_TRIGGERED", `Autonomous loop safety cutoff triggered at node [${stateName}]. Visited ${activeCycleMap[stateName]} times.`);

                return {
                    _transitionState: "FAILURE",
                    _transitionReason: `Cycle breaker tripped: autonomous repetition cap exceeded (${maxCyclesAllowed}).`,
                    _cycleCount: {} // Flush map safely
                };
            }
        }

        // 2. Filter State (READ)
        const filteredState = filterStateRead(state, stateDef);

        // 2b. HITL/Approval Check
        const isApprovalGate = stateDef.action?.requiresApproval;
        if (stateDef.hitl || isApprovalGate) {
            if (state._humanInput === undefined || state._humanInput === null) {
                throw new Error(`State ${stateName} requires human input/approval but none was provided.`);
            }
        }

        // 3. Action Phase
        let actionResult: any;
        const stateTimeout = stateDef.timeout || workflow.settings?.defaultTimeout || 30000;
        const actionTimeout = stateDef.action.timeout || stateTimeout;
        const parentSignal = config?.signal;

        if (state._resumePhase === "verification") {
            trace("RESUMPTION", `Resuming state ${stateName} directly at verification phase.`);
            actionResult = state._context.actionResult !== undefined ? state._context.actionResult : state._humanInput;
            state._resumePhase = null;
        } else {
            try {
                const actionGate = new PhaseBoundaryGate({ epochLimit: actionTimeout });
                actionResult = await actionGate.intercept(
                    `Action(${stateName})`,
                    (boundaryGate) => processActionPhase(stateName, stateDef, state, filteredState, trace, workflow, boundaryGate),
                    parentSignal
                );

                // 🛑 THE EARLY EXIT HOOK (e.g., Output Validation Failures)
                if (actionResult && actionResult._transitionState) {
                    const finalizedEarlyExit = finalizeNodeState(stateName, state, stateDef, actionResult, actionResult._transitionState, actionResult._transitionReason || "Early exit", trace);

                    // Explicitly pass a clean, unpolluted snapshot copy back to LangGraph
                    finalizedEarlyExit._cycleCount = { ...activeCycleMap };
                    return finalizedEarlyExit;
                }
            } catch (err: any) {
                const errorPayload = handleActionFailure(stateName, state, err, trace);

                // Explicitly pass a clean, unpolluted snapshot copy back to LangGraph
                errorPayload._cycleCount = { ...activeCycleMap };
                return errorPayload;
            }
        }

        // 4. Verification Phase
        let transitionState: string;
        let transitionReason: string;
        let verificationUpdates: Record<string, any> | null = null;

        if (stateDef.verification) {
            const verificationTimeout = stateDef.verification.timeout || stateTimeout;

            try {
                const verificationGate = new PhaseBoundaryGate({ epochLimit: verificationTimeout });
                const verificationResult = await verificationGate.intercept(
                    `Verification(${stateName})`,
                    (boundaryGate) => processVerificationPhase(stateName, stateDef, actionResult, filteredState, trace, workflow, boundaryGate),
                    parentSignal
                );
                transitionState = verificationResult.state;
                transitionReason = verificationResult.reason;
                verificationUpdates = verificationResult.update || null;
            } catch (err: any) {
                trace("VERIFICATION_FAILURE", `Verification failed or timed out: ${err.message}`);
                transitionState = "FAILURE";
                transitionReason = `Verification error: ${err.message}`;
            }
        } else {
            transitionState = "SUCCESS";
            transitionReason = "No verification phase defined.";
        }

        // 5. Finalize State (Nominal Paths)
        const updateResult = finalizeNodeState(stateName, state, stateDef, actionResult, transitionState, transitionReason, trace);

        // Explicitly pass a clean, unpolluted snapshot copy back to LangGraph
        updateResult._cycleCount = { ...activeCycleMap };

        if (verificationUpdates) {
            updateResult._context = { ...updateResult._context, ...verificationUpdates };
        }

        // 6. Record to Tape
        const isEval = config?.configurable?.evalMode === true;
        await handleRecording(stateName, state, updateResult, workflow, trace, isEval);

        return updateResult;
    };
}

/**
 * Handles the Action Phase, including HITL and Approval Gates.
 */
async function processActionPhase(stateName: string, stateDef: StateDefinition, state: AgentStateType, filteredState: any, trace: any, workflow: WorkflowSchema, signal: AbortSignal) {
    const isApprovalGate = stateDef.action?.requiresApproval;

    if (stateDef.hitl || isApprovalGate) {
        trace("HITL_RESUMPTION", `Processing human input/approval for state: ${stateName}`);
        // Note: Check is performed in createDynamicNode for better error bubbling

        if (isApprovalGate && !stateDef.hitl) {
            const isApproved = state._humanInput === true || state._humanInput?.approved === true || String(state._humanInput).toLowerCase() === 'yes';
            if (!isApproved) {
                trace("APPROVAL_REJECTED", `Action rejected by human.`);
                return {
                    _transitionState: "REJECTED",
                    _transitionReason: "Human rejected the action execution.",
                    _stepCount: state._stepCount + 1,
                    _currentStateId: stateName
                };
            }
            trace("APPROVAL_GRANTED", `Action approved by human.`);
        } else {
            trace("HITL_INPUT_RECEIVED", `Human response received.`);
            return state._humanInput;
        }
    }

    const actionResult = await executeAction(stateDef.action, filteredState, stateDef.agent, trace, workflow, signal);

    if (stateDef.outputSchema) {
        try {
            await validateOutput(actionResult, stateDef.outputSchema);
        } catch (err: any) {
            trace("VALIDATION_ERROR", `Output validation failed: ${err.message}`);
            return {
                _context: { lastValidationError: err.message },
                _transitionState: "VALIDATION_ERROR",
                _transitionReason: `Output validation failed: ${err.message}`,
                _stepCount: state._stepCount + 1,
                _currentStateId: stateName
            };
        }
    }

    return actionResult;
}

/**
 * Handles the Verification Phase.
 */
async function processVerificationPhase(stateName: string, stateDef: StateDefinition, actionResult: any, filteredState: any, trace: any, workflow: WorkflowSchema, signal: AbortSignal) {
    const agent = stateDef.agent ? agentManager.getAgent(stateDef.agent) : undefined;
    const result = await executeVerification(stateDef.verification, actionResult, filteredState, trace, agent, workflow, signal);

    // Enforcement: Check against expectedOutputs if defined
    const expected = stateDef.verification.expectedOutputs || [];
    if (expected.length > 0 && !expected.includes(result.state)) {
        throw new Error(`Invalid verification state '${result.state}' in node '${stateName}'. Expected one of: ${expected.join(', ')}`);
    }

    return result;
}

/**
 * Prepares the final state update object.
 */
function finalizeNodeState(stateName: string, state: AgentStateType, stateDef: StateDefinition, actionResult: any, transitionState: string, transitionReason: string, trace: any) {
    const { updates, rootUpdates } = filterStateWrite(actionResult, stateDef);
    const usage = (trace as any).getUsage();

    trace("NODE_COMPLETE", `State ${stateName} complete: ${transitionState}`, { updates, rootUpdates });

    return {
        ...rootUpdates,
        _context: updates,
        _transitionState: transitionState,
        _transitionReason: transitionReason,
        _humanInput: null,
        _resumePhase: null,
        _stepCount: state._stepCount + 1,
        _currentStateId: stateName,
        _lastUsage: usage,
        _cumulativeUsage: usage,
        _cycleCount: state._cycleCount || {} // Added default safe value initialization
    };
}

/**
 * Creates a standard tracing function for a node execution.
 */
function createTracer(stateName: string, threadId: string | null, observers: WorkflowObserver[]) {
    let accumulatedUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 };

    const tracer = (type: string, message: string, metadata: any = {}) => {
        const traceMetadata = {
            threadId: threadId || "unknown",
            ...metadata
        };
        observers.forEach(o => o.onTrace?.(type, message, traceMetadata));
    };

    (tracer as any).addUsage = (usage: TokenUsage | null) => {
        if (!usage) return;
        accumulatedUsage.promptTokens += usage.promptTokens;
        accumulatedUsage.completionTokens += usage.completionTokens;
        accumulatedUsage.totalTokens += usage.totalTokens;
        accumulatedUsage.estimatedCost = (accumulatedUsage.estimatedCost || 0) + (usage.estimatedCost || 0);
    };

    (tracer as any).getUsage = () => accumulatedUsage;

    return tracer;
}



/**
 * Filters the global state to provide only the requested variables to a node.
 */
function filterStateRead(state: AgentStateType, stateDef: StateDefinition) {
    const filtered: Record<string, any> = {};
    const frameworkKeys = ["messages", "_threadId", "_stepCount", "_maxSteps", "_terminationReason"];

    // Always include framework metadata
    for (const key of frameworkKeys) {
        if (key in state) filtered[key] = (state as any)[key];
    }

    // Include explicitly requested domain variables
    if (stateDef.stateVariables?.read) {
        for (const key of stateDef.stateVariables.read) {
            if (frameworkKeys.includes(key)) continue;
            filtered[key] = (key in state) ? (state as any)[key] : state._context[key];
        }
    }

    return filtered;
}

/**
 * Dispatches and executes the action based on its type.
 */
async function executeAction(action: ActionDefinition, filteredState: any, agentKey: string | undefined, trace: any, workflow: WorkflowSchema, signal: AbortSignal) {
    const rawAgent = agentKey ? agentManager.getAgent(agentKey) : null;
    const agent = wrapAgentForUsage(rawAgent, trace);
    const cwd = workflow?.settings?.cwd || process.cwd();

    switch (action.type) {
        case "function": {
            const cacheKey = `action:${action.path}`;
            let mod = actionCache.get(cacheKey);
            if (!mod) {
                const absolutePath = path.isAbsolute(action.path!) ? action.path! : path.resolve(cwd, action.path!);
                mod = await import(`file://${absolutePath}`);
                actionCache.set(cacheKey, mod);
            }
            if (typeof mod.run !== 'function') throw new Error(`Action at ${action.path} lacks 'run' function.`);
            const payload = { ...((action as any).args || {}), ...filteredState };
            return await mod.run(payload, agent, workflow?.settings?.orchestrator, signal);
        }
        case "bash": {
            if (action.sandboxed) {
                return executeSandboxedBash(action.command!, action.sandboxFiles, action.sandboxEnv, cwd, trace, signal);
            }
            return new Promise((resolve, reject) => {
                const child = spawn(action.command!, {
                    shell: true,
                    cwd,
                    signal,
                    env: { ...process.env, AI_HARNESS_SECURE: "true" }
                });

                let stdoutData = "";
                let stderrData = "";

                child.stdout.on('data', (data: any) => {
                    const chunk = data.toString();
                    stdoutData += chunk;
                    trace("ACTION_STREAM", chunk, { stream: 'stdout' });
                });

                child.stderr.on('data', (data: any) => {
                    const chunk = data.toString();
                    stderrData += chunk;
                    trace("ACTION_STREAM", chunk, { stream: 'stderr' });
                });

                child.on('close', (code: any) => {
                    if (code === 0) {
                        resolve({ stdout: stdoutData, stderr: stderrData, exitCode: code });
                    } else {
                        const bashError = new Error(`Command failed with exit code ${code}`);
                        (bashError as any).stdout = stdoutData;
                        (bashError as any).stderr = stderrData;
                        (bashError as any).exitCode = code;
                        reject(bashError);
                    }
                });

                child.on('error', (err) => {
                    if (err.name === 'AbortError') {
                        reject(new Error(`Action timed out or aborted.`));
                    } else {
                        reject(err);
                    }
                });
            });
        }
        case "mcp": {
            const tool = toolRegistry.getTool(action.name!);
            if (!tool) throw new Error(`MCP Tool ${action.name} not found in ToolRegistry. Ensure it is registered during initialization.`);
            const rawResult = await tool.invoke(filteredState);
            return (rawResult && typeof rawResult === 'object' && 'update' in rawResult)
                ? (rawResult.update.context || rawResult.update)
                : rawResult;
        }
        case "workflow": {
            let schemaPath = action.path;
            if (action.dynamicPathKey && filteredState[action.dynamicPathKey]) {
                schemaPath = filteredState[action.dynamicPathKey];
            }

            if (!schemaPath) {
                throw new Error(`Workflow action requires a 'path' or a valid 'dynamicPathKey' to the schema file.`);
            }

            const absolutePath = path.isAbsolute(schemaPath) ? schemaPath : path.resolve(cwd, schemaPath);

            let rawSchema: string;
            try {
                rawSchema = await fs.readFile(absolutePath, "utf-8");
            } catch (err: any) {
                throw new Error(`Failed to read workflow schema at ${absolutePath}: ${err.message}`);
            }

            const subSchema = validateWorkflowSchema(rawSchema);
            const subWorkflowApp = compileWorkflow(subSchema);

            // Construct an isolated thread ID for the subworkflow
            const parentThreadId = filteredState._threadId || "unknown";
            const parentStep = filteredState._stepCount !== undefined ? filteredState._stepCount : 0;
            const subThreadId = `${parentStep}_${parentThreadId}`;

            // Initialize the subworkflow state using the filtered context
            const initialState = {
                ...filteredState,
                _threadId: subThreadId,
                _stepCount: 0,
                _currentStateId: null,
                _transitionState: null,
                _transitionReason: null,
                _terminationReason: null,
                _humanInput: null
            };

            const result = await subWorkflowApp.invoke(initialState, { configurable: { thread_id: subThreadId }, signal });
            return result;
        }
        default:
            throw new Error(`Unsupported action type: ${action.type}`);
    }
}

/**
 * Validates the action result against a provided schema.
 */
async function validateOutput(actionResult: any, schemaDef: any) {
    let schema: any;

    if (typeof schemaDef === 'string' && (schemaDef.endsWith('.ts') || schemaDef.endsWith('.js'))) {
        const cacheKey = `schema:${schemaDef}`;
        let mod = actionCache.get(cacheKey);
        if (!mod) {
            const absolutePath = path.isAbsolute(schemaDef) ? schemaDef : path.resolve(process.cwd(), schemaDef);
            mod = await import(`file://${absolutePath}`);
            actionCache.set(cacheKey, mod);
        }
        schema = mod.schema;
        if (!schema) throw new Error(`Schema at ${schemaDef} lacks 'schema' export.`);
    } else if (typeof schemaDef === 'object' && schemaDef.safeParse) {
        schema = schemaDef;
    } else {
        throw new Error(`Unsupported schema format: ${typeof schemaDef}. Must be a Zod object or a path to a schema file.`);
    }

    const result = schema.safeParse(actionResult);
    if (!result.success) {
        const errors = result.error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
        throw new Error(`Zod Validation Failed: ${errors}`);
    }
}

/**
 * Handles action failures by returning a standardized error state.
 */
function handleActionFailure(stateName: string, state: AgentStateType, err: any, trace: any) {
    trace("ACTION_FAILURE", `Action failed in state ${stateName}: ${err.message}`, {
        stdout: err.stdout,
        stderr: err.stderr,
        exitCode: err.exitCode
    });

    return {
        _context: {
            lastError: err.message,
            lastStdout: err.stdout,
            lastStderr: err.stderr
        },
        _transitionState: "FAILURE",
        _transitionReason: `Action execution failed: ${err.message}`,
        _stepCount: state._stepCount + 1,
        _currentStateId: stateName,
        _cycleCount: state._cycleCount || {}
    };
}

/**
 * Dispatches and executes the verification logic.
 */
async function executeVerification(verification: ActionDefinition, actionResult: any, filteredState: any, trace: any, agent: any, workflow: WorkflowSchema, signal: AbortSignal) {
    let rawResult: any;
    let reasonBase: string = "";
    const cwd = workflow?.settings?.cwd || process.cwd();

    switch (verification.type) {
        case "function": {
            const cacheKey = `verify:${verification.path}`;
            let mod = actionCache.get(cacheKey);
            if (!mod) {
                const absolutePath = path.isAbsolute(verification.path!) ? verification.path! : path.resolve(cwd, verification.path!);
                mod = await import(`file://${absolutePath}`);
                actionCache.set(cacheKey, mod);
            }
            if (typeof mod.verify !== 'function') throw new Error(`Verification at ${verification.path} lacks 'verify' function.`);
            rawResult = await mod.verify(actionResult, filteredState, agent, signal);
            reasonBase = `Function: ${verification.path}`;
            break;
        }
        case "bash": {
            if (verification.sandboxed) {
                try {
                    const res = await executeSandboxedBash(verification.command!, verification.sandboxFiles, verification.sandboxEnv, cwd, trace, signal);
                    rawResult = res.stdout.trim();
                } catch (e: any) {
                    rawResult = "FAILURE";
                }
            } else {
                rawResult = await new Promise((resolve) => {
                    const child = spawn(verification.command!, {
                        shell: true,
                        cwd,
                        signal
                    });

                    let stdoutData = "";
                    child.stdout.on('data', (data: any) => stdoutData += data.toString());

                    child.on('close', (code: any) => {
                        resolve(stdoutData.trim());
                    });

                    child.on('error', (err: any) => {
                        resolve("FAILURE");
                    });
                });
            }
            reasonBase = `Bash: ${verification.command}`;
            break;
        }
        case "mcp": {
            const tool = toolRegistry.getTool(verification.name!);
            if (!tool) throw new Error(`MCP Tool ${verification.name} not found in ToolRegistry.`);
            const response = await tool.invoke({ actionResult, ...filteredState });
            rawResult = (response && typeof response === 'object' && 'update' in response)
                ? (response.update._transitionState || response.update.transitionState || "SUCCESS")
                : (typeof response === 'string' ? response.trim() : JSON.stringify(response));
            reasonBase = `MCP: ${verification.name}`;
            break;
        }
        default:
            throw new Error(`Unsupported verification type: ${verification.type}`);
    }

    if (typeof rawResult === 'string') {
        return { state: rawResult, reason: `Verified by ${reasonBase}` };
    }
    return {
        state: rawResult.state || "SUCCESS",
        reason: rawResult.reason || `Verified by ${reasonBase}`,
        update: rawResult.update || null
    };
}

/**
 * Filters the action results based on the write mask.
 */
function filterStateWrite(actionResult: any, stateDef: StateDefinition) {
    const updates: Record<string, any> = {};
    const rootUpdates: Record<string, any> = {};
    const frameworkWriteKeys = ["_terminationReason"];
    const frameworkContextKeys = ["lastError", "lastStdout", "lastStderr", "lastValidationError"];
    const readOnlySystemVariables = ["_threadId", "_stepCount", "_maxSteps", "_currentStateId", "_transitionState"];
    const allowedRootWriteKeys = ["messages", "toolCalls"];

    // 1. Framework Implicit Writes (Root)
    for (const key of frameworkWriteKeys) {
        const legacyKey = key.startsWith('_') ? key.substring(1) : key;
        if (actionResult && (actionResult[key] !== undefined || actionResult[legacyKey] !== undefined)) {
            rootUpdates[key] = actionResult[key] ?? actionResult[legacyKey];
        }
    }

    // 1b. Framework Implicit Writes (Context)
    for (const key of frameworkContextKeys) {
        if (actionResult && actionResult._context && actionResult._context[key] !== undefined) {
            updates[key] = actionResult._context[key];
        }
    }

    // 2. Schema Explicit Writes
    const isPrimitive = actionResult !== null && typeof actionResult !== 'object';

    if (stateDef.stateVariables?.write) {
        for (const key of stateDef.stateVariables.write) {
            if (frameworkWriteKeys.includes(key)) continue;

            let value = undefined;
            if (isPrimitive) {
                value = actionResult;
            } else if (actionResult) {
                if (actionResult[key] !== undefined) {
                    value = actionResult[key];
                } else if (actionResult._context && actionResult._context[key] !== undefined) {
                    value = actionResult._context[key];
                }
            }

            if (value !== undefined) {
                if (allowedRootWriteKeys.includes(key)) {
                    rootUpdates[key] = value;
                } else if (!readOnlySystemVariables.includes(key)) {
                    updates[key] = value;
                }
            }
        }
    }

    return { updates, rootUpdates };
}



/**
 * Wraps an agent in a Proxy to automatically track token usage metadata.
 */
function wrapAgentForUsage(agent: any, trace: any) {
    if (!agent) return null;

    return new Proxy(agent, {
        get(target, prop, receiver) {
            const original = Reflect.get(target, prop, receiver);
            if (prop === 'invoke' && typeof original === 'function') {
                return async (...args: any[]) => {
                    const response = await original.apply(target, args);
                    const usage = extractUsage(response);
                    if (usage) {
                        trace("TOKEN_USAGE", `Captured usage: ${usage.totalTokens} tokens`, usage);
                        trace.addUsage(usage);
                    }
                    return response;
                };
            }
            return original;
        }
    });
}

/**
 * Extracts usage metadata from a LangChain message response.
 */
function extractUsage(response: any): TokenUsage | null {
    if (!response) return null;

    if (response.usage_metadata) {
        return {
            promptTokens: response.usage_metadata.input_tokens,
            completionTokens: response.usage_metadata.output_tokens,
            totalTokens: response.usage_metadata.total_tokens,
            estimatedCost: response.usage_metadata.total_tokens * 0.00001
        };
    }

    const usage = response.additional_kwargs?.tokenUsage || response.response_metadata?.tokenUsage;
    if (usage) {
        return {
            promptTokens: usage.prompt_tokens || usage.input_tokens || 0,
            completionTokens: usage.completion_tokens || usage.output_tokens || 0,
            totalTokens: usage.total_tokens || 0,
            estimatedCost: (usage.total_tokens || 0) * 0.00001
        };
    }

    return null;
}

