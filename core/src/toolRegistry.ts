/**
 * Registry for user-provided tools (MCP, custom, etc.)
 * This allows the framework to remain agnostic of the specific 
 * tool implementation or file structure of the consumer application.
 */
class ToolRegistry {
    private tools = new Map<string, any>();

    /**
     * Registers a tool instance that can be invoked by the framework.
     * @param name The unique name of the tool (as referenced in the JSON schema)
     * @param tool The tool instance (must implement .invoke())
     */
    registerTool(name: string, tool: any) {
        this.tools.set(name, tool);
    }

    /**
     * Retrieves a registered tool by name.
     */
    getTool(name: string): any | null {
        return this.tools.get(name) || null;
    }

    /**
     * Returns all registered tools.
     */
    getAllTools(): any[] {
        return Array.from(this.tools.values());
    }

    /**
     * Clears all registered tools (useful for tests).
     */
    clear() {
        this.tools.clear();
    }
}

export const toolRegistry = new ToolRegistry();
