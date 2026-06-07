import { TokenUsage } from './schema.js';

export interface ReplayHashes {
    workflowHash: string;
    actionHash?: string;
    verificationHash?: string;
    sandboxFiles?: Record<string, string>;
}

export interface TapeSnapshot {
    _threadId: string;
    _stepNumber: number;
    nodeName: string;
    workflowName: string;
    workflowVersion: string;
    inputState: any;
    toolOutput: any;
    _transitionReason?: string;
    _usage?: TokenUsage | null;
    hashes?: ReplayHashes;
}

export interface ITapeStorage {
    read(threadId: string, stepCount: number): Promise<TapeSnapshot | null>;
    write(snapshot: TapeSnapshot): Promise<void>;
    listThreads(): Promise<string[]>;
    listSteps(threadId: string): Promise<number[]>;
}
