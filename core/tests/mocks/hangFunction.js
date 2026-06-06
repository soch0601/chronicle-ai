export const run = async (state, agent, orchestrator, signal) => {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            resolve({ hung: true });
        }, 3000);
        
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(new Error("Function Aborted Cleanly"));
            });
        }
    });
};

export const verify = async (actionResult, state, agent, signal) => {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            resolve({ state: "SUCCESS", reason: "Finished" });
        }, 3000);
        
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(new Error("Verification Aborted Cleanly"));
            });
        }
    });
};
