export interface AgentConfiguration {
  [key: string]: any; 
}

import { TapeSnapshot, ITapeStorage } from './dataReplay.js';

/**
 * Minimal interface for a custom agent.
 * Allows users to provide any object with an 'invoke' method as an agent.
 */
export interface CustomAgent {
  invoke(input: any, config?: any): Promise<any>;
  initialize?(): Promise<void>;
}

export interface IOrchestrationProvider {
    setCount(key: string, count: number): Promise<void>;
    atomicDecrementCount(key: string): Promise<number>;
    [key: string]: any;
}


export type ActionType = "function" | "bash" | "mcp" | "workflow";

export interface ActionDefinition {
  type: ActionType;
  path?: string;   // For "function" or "workflow"
  dynamicPathKey?: string; // For "workflow" to resolve path from state
  command?: string; // For "bash"
  name?: string;    // For "mcp"
  timeout?: number; // Max execution time in ms (default 30s)
  requiresApproval?: boolean; // If true, forces HITL approval before execution
}

export interface VerificationDefinition {
  type: ActionType;
  path?: string;    // For "function"
  command?: string; // For "bash"
  name?: string;    // For "mcp"
  timeout?: number; // Max execution time in ms (default 30s)
  expectedOutputs: string[]; // Strict list of all possible outputs
}

export interface StateVariablesFilter {
  read: string[];
  write: string[];
}

export interface TransitionRule {
  condition: string;
  nextState: string;
}

export type HITLType = "approval" | "input" | "selection";

export interface HITLConfig {
  type: HITLType;
  prompt: string;
  options?: string[];
  placeholder?: string;
}

export interface StateDefinition {
  agent?: string; // Reference to an agent in WorkflowSchema.agents
  hitl?: HITLConfig; // Human-in-the-loop configuration
  action: ActionDefinition;
  outputSchema?: any; // Optional Zod or JSON schema for action results
  verification: VerificationDefinition;
  stateVariables: StateVariablesFilter;
  transitions: TransitionRule[];
  timeout?: number; // Override default timeout for all phases in this state
}

export interface WorkflowSettings {
  logPath?: string;
  tapeDir?: string;
  cwd?: string;
  storage?: ITapeStorage;
  orchestrator?: IOrchestrationProvider;
  [key: string]: any;
}

export interface WorkflowSchema {
  name: string;
  version: string;
  initialState: string;
  maxSteps?: number;
  settings?: WorkflowSettings;
  agents: Record<string, AgentConfiguration>;
  states: Record<string, StateDefinition>;
}
