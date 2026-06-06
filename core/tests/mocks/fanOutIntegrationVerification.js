export async function verify(actionResult, filteredState) {
    const results = actionResult.workerResults || filteredState.workerResults;
    if (results && results.length === 3) {
        return {
            state: "SUCCESS",
            reason: "Verified 3 results"
        };
    }
    return {
        state: "FAILURE",
        reason: "Expected 3 results"
    };
}
