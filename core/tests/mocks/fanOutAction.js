export async function run(state, agent, orchestrator) {
    if (orchestrator && orchestrator.setCount) {
        await orchestrator.setCount("test-key", 5);
    }
    return {
        _transitionState: "__SUSPEND__",
        _context: { fannedOut: true }
    };
}
