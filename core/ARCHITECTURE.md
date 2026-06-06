# Architecture: Chronicle AI Core

This document outlines the design philosophy and technical architecture of Chronicle AI.

## 1. Design Philosophy

Chronicle AI is built on the principle of **"Agentic Safety Through Structure."** 

Traditional agent frameworks often treat the agent as the "master" of the workflow. Chronicle reverses this: the **Orchestrator** is the master, and agents are "black-box" tools that the orchestrator calls, validates, and records.

### Key Pillars:
1.  **State Isolation**: Prevent "state bleed" between agents.
2.  **Auditability**: Every decision must be recorded and replayable.
3.  **Validation**: LLM outputs are treated as untrusted until verified by code or schema.

---

## 2. State Management & Isolation

Chronicle uses a two-tier state system within the LangGraph `AgentState`.

### Framework Variables (`_` Prefix)
Variables prefixed with `_` are reserved for the framework. They manage the internal lifecycle and safety boundaries of the workflow:
- `_threadId`: Session identifier.
- `_currentStateId`: Tracks the active node for logging and observability.
- `_stepCount` / `_maxSteps`: Safety counters for execution step limit governors.
- `_cycleCount` / `_maxCycles`: Counters for the autonomous cycle circuit breaker.
- `_transitionState`: The state transition condition key.
- `_transitionReason`: Audit trail explaining why a transition was chosen.
- `_resumePhase`: Tracks phase state for Human-in-the-Loop (HITL) resumption.
- `_humanInput`: Holds human feedback or approval responses.
- `_lastUsage` / `_cumulativeUsage`: Live token usage and estimated cost ledger tracking.
- `_context`: A managed, isolated pool for all user domain data.

### Domain Variable Masking
When a node executes, it does not see the entire global state. Instead, it receives a **Read Mask** containing only the variables it needs. Similarly, it can only write to the variables defined in its **Write Mask** (enforced by the `nodeFactory`). This enforces strict data encapsulation and prevents global namespace pollution or side-effect leaks.

---

## 3. Node Execution Lifecycle

Every node in a Chronicle graph follows a strict lifecycle managed by the `nodeFactory`:

1.  **Replay Check**: If in `replay` mode, the node checks the **Transaction Tape** for a cached result.
2.  **Safety Gates**: Enforces autonomous cyclic recursion boundaries. If the node is hit repeatedly without human interaction, a cycle circuit breaker is tripped.
3.  **Action Phase**: The primary logic (LLM call, Bash script, dynamic sub-workflow, or function) is executed:
    - If `outputSchema` is defined, the action output is validated against the schema (Zod or file export) immediately.
4.  **Verification Phase**: A separate verification step (function, bash command, or MCP tool) validates the action result and asserts a transition condition.
5.  **Recording Phase**: The execution snapshot is serialized to the **Transaction Tape** for replayability.

---

## 4. Transaction Tapes

Transaction Tapes are the "Flight Data Recorder" for your AI. They are stored as step-indexed JSON files:

```json
{
  "_threadId": "abc-123",
  "_stepNumber": 4,
  "nodeName": "calculate_risk",
  "workflowName": "risk-analysis",
  "workflowVersion": "1.0.0",
  "inputState": { ... },
  "toolOutput": { ... },
  "_transitionReason": "Risk score 85 exceeded threshold",
  "_usage": { "promptTokens": 120, "completionTokens": 50, "totalTokens": 170 }
}
```

This architecture enables **Time-Travel Debugging**. You can take a tape from a production failure and run it through the `evalRunner` to replay the isolated node execution in a test harness.

---

## 5. The Routing Engine

Chronicle uses a **Universal Schema Router**. Instead of hardcoding transition paths in TypeScript code, the router reads the `transitions` array from the JSON schema. It cross-references the `_transitionState` returned by the node's verification step with the schema to find the next target.

System failures (such as cyclic recursion bounds or maximum execution steps exceeded) trigger immediate overrides that route the state out of user-land logic and directly into the framework security `auditor` node for clean shutdowns.
