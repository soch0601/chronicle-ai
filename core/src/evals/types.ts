export interface EvalResult {
    threadId: string;
    step: number;
    nodeName: string;
    passed: boolean;
    error?: string;
    diff?: {
        expected: any;
        actual: any;
    };
    versionAudit: {
        tapeVersion: string;
        schemaVersion: string;
    };
    semanticMatch?: boolean;
    reason?: string;
    usage?: any;
}

export interface EvalOptions {
    judgeAgent?: string;
}
