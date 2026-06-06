import { TokenUsage } from './schema.js';

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
}

export interface ITapeStorage {
    read(threadId: string, stepCount: number): Promise<TapeSnapshot | null>;
    write(snapshot: TapeSnapshot): Promise<void>;
    listThreads(): Promise<string[]>;
    listSteps(threadId: string): Promise<number[]>;
}
