import { agentManager } from '../agentManager.js';
import { HumanMessage } from '@langchain/core/messages';

export interface ComparisonResult {
    passed: boolean;
    semanticMatch: boolean;
}

/**
 * Orchestrates the comparison between expected and actual output.
 */
export async function compareOutputs(
    expected: any, 
    actual: any, 
    judgeAgent?: string
): Promise<ComparisonResult> {
    const expectedTransition = expected._transitionState;
    const actualTransition = actual._transitionState;

    let passed = expectedTransition === actualTransition;
    let semanticMatch = false;

    // Semantic Fallback
    if (!passed && judgeAgent) {
        semanticMatch = await compareSemantically(
            { transition: expectedTransition, context: expected._context },
            { transition: actualTransition, context: actual._context },
            judgeAgent
        );
        if (semanticMatch) passed = true;
    }

    return { passed, semanticMatch };
}

/**
 * Uses an AI Judge to determine if two node outputs are semantically equivalent.
 */
async function compareSemantically(expected: any, actual: any, judgeKey: string): Promise<boolean> {
    try {
        const judge = agentManager.getAgent(judgeKey);
        
        const prompt = `
        You are an AI Quality Auditor. Your job is to determine if a recent change in an AI agent's logic has caused a functional regression.
        
        GOAL: Determine if the "Actual Output" is semantically equivalent to the "Expected Output" in terms of intent, data content, and downstream impact.
        
        EXPECTED OUTPUT:
        ${JSON.stringify(expected, null, 2)}
        
        ACTUAL OUTPUT:
        ${JSON.stringify(actual, null, 2)}
        
        RULES:
        1. Ignore minor phrasing differences in text if the core information is the same.
        2. If the transition states are different (e.g., SUCCESS vs FAILURE), they are likely NOT equivalent unless the actual output clearly explains why the new state is correct.
        3. Data values (emails, IDs, numbers) MUST match exactly.
        
        Return ONLY a JSON object: { "equivalent": true/false, "reason": "brief explanation" }
        `;

        const response = await judge.invoke([new HumanMessage(prompt)]);
        const content = typeof response === 'string' ? response : (response as any).content;
        
        const jsonMatch = content.match(/\{.*\}/s);
        if (!jsonMatch) return false;
        
        const result = JSON.parse(jsonMatch[0]);
        return result.equivalent === true;
    } catch (err: any) {
        console.error(`[SemanticJudge] Failed to evaluate: ${err.message}`);
        return false;
    }
}
