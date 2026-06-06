export async function verify(humanResponse, state, agent) {
    if (humanResponse && humanResponse.decision === "APPROVED") {
        return "SUCCESS";
    }
    if (humanResponse && humanResponse.decision === "REJECTED") {
        return "REJECTED";
    }
    return "FAILURE";
}
