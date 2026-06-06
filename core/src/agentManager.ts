import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { CustomAgent } from "./schemaDefinitions.js";

/**
 * Manages the registry of AI agents available to the workflow.
 * Implements a "Bring Your Own Agent" philosophy: the framework only 
 * handles orchestration and expects pre-instantiated agents to be registered.
 */
export class AgentManager {
    private instances: Map<string, BaseChatModel | CustomAgent> = new Map();

    /**
     * Registers a pre-instantiated agent.
     * This can be any LangChain BaseChatModel or a CustomAgent (with an 'invoke' method).
     */
    defineAgent(key: string, agent: BaseChatModel | CustomAgent) {
        this.instances.set(key, agent);
    }

    /**
     * Retrieves a registered agent by its name.
     * Throws if the agent hasn't been defined yet.
     */
    getAgent(key: string): BaseChatModel | CustomAgent {
        const agent = this.instances.get(key);
        
        if (!agent) {
            throw new Error(`AGENT_NOT_DEFINED: Agent '${key}' is required by the workflow but has not been registered via agentManager.defineAgent().`);
        }

        return agent;
    }
}

export const agentManager = new AgentManager();
