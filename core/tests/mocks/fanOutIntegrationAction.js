export async function run(state, agent, orchestrator) {
    // 1. The action determines we need to spawn 3 workers
    const itemsToProcess = ["item1", "item2", "item3"];
    
    // 2. Set the count in the orchestrator
    if (orchestrator && orchestrator.setCount) {
        await orchestrator.setCount("fanout-test-thread", itemsToProcess.length);
    }
    
    // 3. Return the payload to the external system (Kafka etc.)
    return {
        _transitionState: "__SUSPEND__",
        pendingItems: itemsToProcess,
        workerResults: [] // Initialize array for workers to push to
    };
}
