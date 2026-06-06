export async function run(payload: any, agent: any) {
    const outputKey = payload.output_key || "project_readme_summary";
    const promptTemplate = payload.prompt_template || "";
    const spawnResults = payload.spawn_results || [];

    const formattedResults = spawnResults.map((r: any) => `- ${r.file}: ${r.summary}`).join("\n");
    const prompt = promptTemplate.replace("{{spawn_results}}", formattedResults);

    let responseText = "";
    if (agent && typeof agent.invoke === 'function') {
        const response = await agent.invoke([
            { role: "system", content: payload.system_prompt || "You are a Technical Documentation Specialist." },
            { role: "user", content: prompt }
        ]);
        responseText = response.content;
    } else {
        responseText = `## Project Architecture Overview\n\nAnalyzed ${spawnResults.length} files. The core interface routes traffic through the entry-points.`;
    }

    return {
        [outputKey]: responseText
    };
}
