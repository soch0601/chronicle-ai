import crypto from "crypto";
import readline from "node:readline/promises";
import fs from "fs/promises";
import path from "path";
import { TapeSnapshot, ReplayHashes } from './dataReplay.js';
import { WorkflowSchema } from './schemaDefinitions.js';
import { AgentStateType } from "./schema.js";
import { HardGateError } from "./engine.js";

function sortKeysRecursively(obj: any): any {
    if (obj === null || typeof obj !== "object") {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(sortKeysRecursively);
    }
    const sortedObj: any = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
        sortedObj[key] = sortKeysRecursively(obj[key]);
    }
    return sortedObj;
}

function getWorkflowHash(schema: WorkflowSchema): string {
    const sorted = sortKeysRecursively(schema);
    return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

async function getFileHash(absolutePath: string): Promise<string> {
    try {
        const content = await fs.readFile(absolutePath);
        return crypto.createHash("sha256").update(content).digest("hex");
    } catch (err: any) {
        throw new Error(`Failed to calculate file hash for '${absolutePath}': ${err.message}`);
    }
}

export async function calculateHashesForState(
    stateName: string,
    workflow: WorkflowSchema,
    cwd: string
): Promise<ReplayHashes> {
    const stateDef = workflow.states[stateName];
    if (!stateDef) {
        throw new Error(`State ${stateName} not found in workflow states.`);
    }

    const workflowHash = getWorkflowHash(workflow);
    let actionHash: string | undefined;
    let verificationHash: string | undefined;
    const sandboxFiles: Record<string, string> = {};

    // 1. Action hash
    if (stateDef.action.type === "function" && stateDef.action.path) {
        const absPath = path.isAbsolute(stateDef.action.path) ? stateDef.action.path : path.resolve(cwd, stateDef.action.path);
        actionHash = await getFileHash(absPath);
    } else if (stateDef.action.type === "bash" && stateDef.action.command) {
        actionHash = crypto.createHash("sha256").update(stateDef.action.command).digest("hex");
    }

    // 2. Verification hash
    if (stateDef.verification) {
        if (stateDef.verification.type === "function" && stateDef.verification.path) {
            const absPath = path.isAbsolute(stateDef.verification.path) ? stateDef.verification.path : path.resolve(cwd, stateDef.verification.path);
            verificationHash = await getFileHash(absPath);
        } else if (stateDef.verification.type === "bash" && stateDef.verification.command) {
            verificationHash = crypto.createHash("sha256").update(stateDef.verification.command).digest("hex");
        }
    }

    // 3. Sandbox files
    if (stateDef.action.sandboxed && stateDef.action.sandboxFiles) {
        for (const file of stateDef.action.sandboxFiles) {
            const absPath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
            sandboxFiles[file] = await getFileHash(absPath);
        }
    }
    if (stateDef.verification?.sandboxed && stateDef.verification.sandboxFiles) {
        for (const file of stateDef.verification.sandboxFiles) {
            const absPath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
            sandboxFiles[file] = await getFileHash(absPath);
        }
    }

    return {
        workflowHash,
        actionHash,
        verificationHash,
        sandboxFiles: Object.keys(sandboxFiles).length > 0 ? sandboxFiles : undefined
    };
}

async function promptUser(query: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    try {
        return await rl.question(query);
    } finally {
        rl.close();
    }
}

/**
 * Handles replay logic by checking for existing state snapshots.
 */
export async function handleReplay(
    stateName: string,
    state: AgentStateType,
    config: any,
    workflow: WorkflowSchema,
    trace: any
): Promise<any | null> {
    const isReplay = config?.configurable?.replay;
    const tapeDir = workflow.settings?.tapeDir;

    if (isReplay && workflow.settings?.storage) {
        const snapshot = await workflow.settings.storage.read(state._threadId || "unknown", state._stepCount);
        if (snapshot) {
            // Hardening: Verify this snapshot belongs to the current node
            if (snapshot.nodeName !== stateName) {
                trace("REPLAY_MISMATCH", `Tape node mismatch at step ${state._stepCount}. Expected ${stateName}, found ${snapshot.nodeName}. Skipping replay.`);
                return null;
            }

            // Hardening: Warn on version mismatch
            if (snapshot.workflowVersion !== workflow.version) {
                trace("REPLAY_VERSION_WARNING", `Version mismatch: Tape is ${snapshot.workflowVersion}, Schema is ${workflow.version}. Attempting replay anyway.`);
            }

            const cwd = workflow.settings?.cwd || process.cwd();
            const currentHashes = await calculateHashesForState(stateName, workflow, cwd);
            const recordedHashes = snapshot.hashes;

            const changes: string[] = [];
            let wasmWarning = false;

            if (recordedHashes) {
                if (currentHashes.workflowHash !== recordedHashes.workflowHash) {
                    changes.push("Workflow schema structure has changed.");
                }
                if (currentHashes.actionHash !== recordedHashes.actionHash) {
                    changes.push(`Action definition/implementation for state '${stateName}' has changed.`);
                }
                if (currentHashes.verificationHash !== recordedHashes.verificationHash) {
                    changes.push(`Verification definition/implementation for state '${stateName}' has changed.`);
                }
                if (currentHashes.sandboxFiles || recordedHashes.sandboxFiles) {
                    const currFiles = currentHashes.sandboxFiles || {};
                    const recFiles = recordedHashes.sandboxFiles || {};
                    const allFileKeys = new Set([...Object.keys(currFiles), ...Object.keys(recFiles)]);
                    for (const file of allFileKeys) {
                        if (currFiles[file] !== recFiles[file]) {
                            changes.push(`Sandbox file '${file}' has changed or been added/removed.`);
                        }
                    }
                }
            } else {
                trace("REPLAY_VALIDATION_MISSING_HASHES", "No verification hashes found in the recorded tape snapshot. Skipping hash validation.");
            }

            const stateDef = workflow.states[stateName];
            const hasUnsandboxedBash = (stateDef.action.type === "bash" && !stateDef.action.sandboxed) ||
                                       (stateDef.verification?.type === "bash" && !stateDef.verification.sandboxed);
            if (hasUnsandboxedBash) {
                wasmWarning = true;
            }

            if (changes.length > 0 || wasmWarning) {
                const bypass = config?.configurable?.bypassReplayValidation === true;
                if (!bypass) {
                    const isEvalMode = config?.configurable?.evalMode === true;
                    const isInteractive = process.stdin.isTTY && !process.env.CI && !isEvalMode;
                    const errMsgParts: string[] = [];
                    if (changes.length > 0) {
                        errMsgParts.push(`Replay validation failed for state '${stateName}'. Detected changes:\n- ${changes.join("\n- ")}`);
                    }
                    if (wasmWarning) {
                        errMsgParts.push(`Warning: WASM is not enabled for state '${stateName}'. Cannot verify if there were extra things affecting the run (like env variables or unknown files).`);
                    }

                    if (!isInteractive) {
                        throw new Error(`Chronicle AI Replay Error: Workflow drift or WASM warning detected in a non-interactive environment for state '${stateName}'. Aborting execution safely. Details:\n${errMsgParts.join("\n")}`);
                    } else {
                        process.stdout.write(`\n--- REPLAY VALIDATION WARNING ---\n${errMsgParts.join("\n\n")}\n\n`);
                        const answer = await promptUser("Do you want to continue? (Y/N): ");
                        if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
                            throw new Error(`Replay aborted by user for state '${stateName}'.`);
                        }
                    }
                } else {
                    trace("REPLAY_VALIDATION_BYPASSED", `Replay validation warnings bypassed via configuration for state ${stateName}.`);
                }
            }

            trace("REPLAY_RECOVERY", `Replaying state ${stateName} from tape.`, { step: state._stepCount });
            return {
                _stepCount: state._stepCount + 1,
                ...snapshot.toolOutput
            };
        }
    }
    return null;
}

/**
 * Records the current step to the transaction tape.
 */
export async function handleRecording(
    stateName: string,
    state: AgentStateType,
    updateResult: any,
    workflow: WorkflowSchema,
    trace: any,
    isEval: boolean = false
): Promise<void> {
    if (isEval || !workflow.settings?.storage) return;

    try {
        const cwd = workflow.settings?.cwd || process.cwd();
        const hashes = await calculateHashesForState(stateName, workflow, cwd);

        const snapshot: TapeSnapshot = {
            _threadId: state._threadId || "unknown",
            _stepNumber: state._stepCount,
            nodeName: stateName,
            workflowName: workflow.name,
            workflowVersion: workflow.version,
            inputState: state,
            toolOutput: updateResult,
            _transitionReason: updateResult._transitionReason,
            _usage: updateResult._lastUsage,
            hashes
        };
        await workflow.settings.storage.write(snapshot);
    } catch (err: any) {
        trace("RECORDING_FAILURE", `Failed to record tape: ${err.message}`);
    }
}
