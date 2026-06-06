import { loadEvalSteps } from './loader.js';
import { compareOutputs } from './comparator.js';
import { createDynamicNode } from '../nodeFactory.js';
import { WorkflowSchema } from '../schemaDefinitions.js';
import { EvalResult, EvalOptions } from './types.js';

import { ITapeStorage } from '../dataReplay.js';

export async function runEval(
    schema: WorkflowSchema,
    storage: ITapeStorage,
    options: EvalOptions = {}
): Promise<EvalResult[]> {
    // 1. Ingest all steps from the Transaction Tape
    const steps = await loadEvalSteps(storage);
    const results: EvalResult[] = [];

    for (const step of steps) {
        const { nodeName, inputState, toolOutput, _threadId, _stepNumber } = step.snapshot;

        // 1b. Node Existence Check
        const nodeDef = schema.states[nodeName];
        if (!nodeDef) {
            results.push({
                threadId: _threadId,
                step: _stepNumber,
                nodeName,
                passed: false,
                error: `Node '${nodeName}' not found in current schema.`,
                versionAudit: {
                    tapeVersion: step.snapshot.workflowVersion || "unknown",
                    schemaVersion: schema.version
                }
            });
            continue;
        }

        try {
            // 2. Re-run node logic (Isolation mode)
            const evalNode = createDynamicNode(nodeName, nodeDef, schema, []);
            const actualOutput = await (evalNode as any)(inputState, {
                configurable: { thread_id: _threadId, evalMode: true }
            });

            // 3. Comparison (Logic isolated in comparator.ts)
            const comparison = await compareOutputs(toolOutput, actualOutput, options.judgeAgent);

            results.push({
                threadId: _threadId,
                step: _stepNumber,
                nodeName,
                passed: comparison.passed,
                semanticMatch: comparison.semanticMatch,
                reason: actualOutput._transitionReason,
                usage: actualOutput._lastUsage,
                diff: comparison.passed ? undefined : {
                    expected: toolOutput._transitionState,
                    actual: actualOutput._transitionState
                },
                versionAudit: {
                    tapeVersion: step.snapshot.workflowVersion || "unknown",
                    schemaVersion: schema.version
                }
            });
        } catch (err: any) {
            results.push({
                threadId: _threadId,
                step: _stepNumber,
                nodeName,
                passed: false,
                error: `Execution Error: ${err.message}`,
                versionAudit: { tapeVersion: "err", schemaVersion: schema.version }
            });
        }
    }
    return results;
}