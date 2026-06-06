import { TapeSnapshot, ITapeStorage } from '../dataReplay.js';

export interface EvalStep {
    threadId: string;
    stepNumber: number;
    snapshot: TapeSnapshot;
}

/**
 * Discovers and loads all tapes from a storage provider.
 */
export async function loadEvalSteps(storage: ITapeStorage): Promise<EvalStep[]> {
    const steps: EvalStep[] = [];

    const threads = await storage.listThreads();

    for (const threadId of threads) {
        const stepNumbers = await storage.listSteps(threadId);

        for (const stepNumber of stepNumbers) {
            const snapshot = await storage.read(threadId, stepNumber);
            if (snapshot) {
                steps.push({
                    threadId: snapshot._threadId,
                    stepNumber: snapshot._stepNumber,
                    snapshot
                });
            }
        }
    }

    return steps;
}
