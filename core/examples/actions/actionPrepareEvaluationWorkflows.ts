export async function run(payload: any) {
    const files = payload.repository_files || [];
    const dynamicWorkflows = files.map((file: string, idx: number) => ({
        id: idx,
        targetFile: file
    }));
    return {
        dynamic_workflows: dynamicWorkflows
    };
}
