export async function run(state, agent) {
    return { 
        terminationReason: "circuit breaker was tripped",
        messages: [{ role: "assistant", content: "Auditor: Circuit breaker tripped." }]
    };
}
