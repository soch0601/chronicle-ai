# 🧵 Chronicle AI

![Chronicle AI Logo](assets/logo.png)

### **The Enterprise Statechart Engine for AI Agents.**
Chronicle AI is a hardened, schema-driven orchestration layer built on top of [LangGraph.js](https://github.com/langchain-ai/langgraphjs). It bridges the gap between chaotic, non-deterministic LLM behaviors and predictable, deterministic enterprise software patterns.

If you are trying to move multi-agent systems past the "demo phase" and into mission-critical production environments where data corruption, runaway token costs, and infinite cyclic loops are completely unacceptable—Chronicle AI was built for you.

---

## Why Enterprise Architects Choose Chronicle Over Raw Frameworks

While popular AI frameworks focus on the "magic" of LLM prompting, Chronicle AI treats agents as untrusted software components that require strict governance, boundaries, and deterministic gates.

| Engineering Challenge | The Standard Framework Approach | The Chronicle AI Standard |
| :--- | :--- | :--- |
| **State Corruption** | Agents read/write directly to a shared global memory space, leading to payload drift and unexpected hallucinations overwriting core data. | **Strict Context Air-Gapping.** Chronicle enforces strict `Read/Write Masks` (`_context`). Nodes are isolated and only see or mutate explicitly granted domain keys. Framework state (`_stepCount`, `_threadId`) is strictly immutable to user-land logic. |
| **Runaway Token Costs** | An agent gets stuck in an autonomous loop, burning through thousands of dollars in API credits before a human or engineer notices. | **Dual-Layer Circuit Breakers.** Proactively halts execution via an automated global `maxSteps` governor and an autonomous cyclic recursion detector that trips if a node is hit repeatedly without human interaction. |
| **Production Regression** | A prompt update or model change subtly breaks a downstream workflow step, completely invisible until a user encounters a crash. | **Deterministic Transaction Tapes & AI Evals.** Every execution step is serialized to an immutable "Tape." When logic or prompts change, the `evalRunner` replays historical tapes through an AI Judge to catch semantic regressions before deployment. |
| **Vendor / Architecture Lock-in** | Graph flows are hardcoded in complex application code, requiring a full compilation, code changes, and redeployment to modify business logic. | **Portable, Schema-Driven Engine.** Your entire multi-agent graph layout, states, and transitions are defined in a standard, portable JSON schema. Business operations can be updated dynamically at runtime without a code deploy. |
| **Asynchronous Scale** | Long-running agent workflows lock up server memory waiting for external APIs, parallel microservices, or human approvals. | **Distributed Dehydration & Fan-Out.** Natively supports Bring-Your-Own (BYO) cluster orchestration. By returning `__SUSPEND__`, Chronicle safely dehydrates graph states, freeing up server resources until external workers (Kafka, SQS) push it back to execution. |


- Bring Your Own (BYO) Everything: Completely decoupled. Pass any storage adapter (Local File System, Postgres, Redis), cluster orchestrator, MCP tools, sub-workflows, or models at runtime.
- Zero-Boilerplate Human-in-the-Loop (HITL): Skip complex LangGraph checkpointing boilerplate. Simply toggle a boolean flag like requiresApproval: true or define a human checkpoint inside a node configuration in your JSON schema, and the graph engine handles thread serialization and suspension automatically.
- Schema-Driven Self-Healing: Route errors dynamically. Use the portable JSON graph definition to intercept system validation errors or tool execution crashes and seamlessly route execution state straight into an autonomous correction or fallback node without messy try-catch application code.
- Granular Step-by-Step Cost Observability: Instead of calculating token consumption at the end of an entire workflow loop, Chronicle monitors and tracks exact API expenses live at every single node transition.

---

## Installation

```bash
npm install @chronicle-ai/core
```

## 🛠️ Quick Start

### 1. Define your Workflow (JSON Schema)
Define your agents, isolated states, error thresholds, and transitions in a standard schema.

```json
{
  "name": "Member Lookup",
  "version": "1.0.0",
  "initialState": "search",
  "states": {
    "search": {
      "action": { "type": "function", "path": "./tools/search.js" },
      "stateVariables": { "read": ["query"], "write": ["result"] },
      "verification": { "type": "bash", "command": "grep -q 'SUCCESS' results.txt", "expectedOutputs": ["SUCCESS", "FAILURE"] },
      "transitions": [
        { "condition": "SUCCESS", "nextState": "__END__" },
        { "condition": "FAILURE", "nextState": "error_handler" }
      ]
    }
  }
}
```

### 2. Compile and Run
Chronicle handles orchestration, automated state masking, and transaction recording out of the box

```typescript
import { compileWorkflow, agentManager } from "@chronicle-ai/core";

// 1. Register your agents (Supports local Ollama, OpenAI, Anthropic, etc.)
agentManager.defineAgent("assistant", myModel);

// 2. Compile from schema
const agent = compileWorkflow(mySchema);

// 3. Execute with thread isolation
const result = await agent.invoke(
  { query: "Find user 123" }, 
  { configurable: { thread_id: "thread_1" } }
);
```


## Compile-Time Schema Verification (Zero Runtime Panics)
Chronicle features an industrial-grade Directed Acyclic Graph (DAG) validator that intercepts structural failures before your workflow initializes.

```typescript
import { validateWorkflowSchema } from "@chronicle-ai/core";

// Throws detailed validation errors before execution
const verifiedSchema = validateWorkflowSchema(rawJsonString);
```

The validator acts as an architectural gatekeeper, enforcing:
- The Inverse Output Contract: Ensures every outcome declared in a node's expectedOutputs array has a matching transition rule. Phantom rules or unhandled outputs throw compilation faults.
- Implicit Error Paths: If a state utilizes dangerous primitives (like bash commands), the engine forces the developer to define an explicit FAILURE or validation catch-all path.
- Isolated State Primitives: Blocks developers from manually creating variables prefixed with an underscore (_), safeguarding the framework's runtime isolation invariants.


## Regression Testing with Isolated Node Replays
Traditional end-to-end integration testing is brittle, slow, and expensive when applied to LLMs. Chronicle solves this by utilizing your historic Transaction Tapes as an isolated unit-testing suite.  

The evalRunner reads raw snapshots from your storage layer, decouples the targeted node from the larger graph, and executes it in strict isolation using the exact state payload it received during the live environment run.


## Continuous Financial & Semantic Governance
Run evaluations locally or inside your CI/CD pipelines to monitor engineering economics and catch semantic drift:

```bash
npm run eval -- --schema=./schemas/billing.json --tapeDir=./tapes --judge=gpt-4o
```


## Execution Diagnostics & Economic Audits
The runner generates a full operational ledger including data diffs, semantic match notifications from your AI Judge, token consumption metrics, and running cost estimations:

```text
🚀 Starting Industrial Eval Runner
===================================
Workflow: Member Lookup (v1.0.0)
Registry: /user/project/ai-data/tapes
Judge:    gpt-4o (Semantic Fallback ENABLED)
===================================

✅ PASS                  | thread_abc123 | search [Tape: v1.0.0]
   └─ Usage: 1,420 tokens ($0.0215)
❌ FAIL (🤖 Semantic Match) | thread_xyz789 | error_handler [Tape: v0.9.8]
   └─ Usage: 2,105 tokens ($0.0315)
   └─ Diff: Expected 'FAILURE', Got 'SUCCESS'
   └─ Reason: Node unexpectedly bypassed the fallback queue.

===================================
FINAL REPORT
===================================
Results:  1 Passed, 1 Failed
Economy:  3,525 tokens used
Est Cost: $0.0530
===================================
```

## Polyglot & Hybrid Agent Orchestration (Local & Remote)
Don't force your engineering team into a single language ecosystem or deployment architecture. Chronicle AI natively orchestrates both local and remote agents/executables:

### 1. Local Agent Execution (Polyglot Runtimes)
Chronicle treats local shell and script environments as first-class execution layers, letting you orchestrate native processes across any language stack directly within your `workflow.json`:
- **Python**: Run heavy data science tasks, semantic search scripts, or ML inference routines locally.
- **Go / Rust**: Execute blindingly fast codebase indexers, AST parsers, or heavy file operations.
- **Shell / CLI Tools**: Orchestrate existing enterprise shell scripts, curl commands, or legacy binaries.

### 2. Remote Agent Orchestration
Chronicle seamlessly integrates and delegates steps to remote environments:
- **Model Context Protocol (MCP)**: Connect to remote MCP servers for standard tool usage.
- **Microservices & Webhooks**: Invoke remote agent APIs via standard HTTP/gRPC.
- **Message Queues (Kafka / SQS)**: Use `__SUSPEND__` to dehydrate the graph state, offloading work to remote worker queues and resuming state when the response returns.

---

## Chronicle AI vs. Leading 2026 Agentic Frameworks

Compared to the frameworks highlighted in the JetBrains 2026 review (e.g., LangGraph, AutoGen, CrewAI, and Semantic Kernel), Chronicle AI addresses several core production limitations:

| Framework | Orchestration Type | Key JetBrains Identified Limitation | How Chronicle AI Solves It |
| :--- | :--- | :--- | :--- |
| **LangGraph** | Graph-Based | "Steep learning curve" & "higher upfront design effort" due to explicit code-based state management. | **Declarative JSON Schemas.** Define your entire multi-agent graph layout and transitions in a standard JSON schema, making runtime changes instant and zero-boilerplate. |
| **AutoGen / CrewAI** | Role-Based | "Limited execution control," "weak HITL support," and "harder-to-constrain behavior." | **Deterministic Boundaries.** Combines role-based node execution with strict schemas, read/write context masks, dual-layer circuit breakers, and built-in human checkpoints. |
| **Semantic Kernel** | Planner-Based | "Heavier upfront structure" and "less flexibility for open-ended autonomy." | **Hybrid Execution.** Offers structured graph deterministic safety with the ability to dynamically route validation failures into self-healing loops without heavy boilerplate. |
| **smolagents / Phidata** | Chain / Tool-Centric | "Minimal production features" and "limited suitability for scaling." | **Production Governance.** Native transaction tape serialization, isolated node replay testing, and granular step-by-step cost and token auditing. |

## Hardening Features Included
- **Circuit Breakers**: Automatically halts execution if an agent enters an infinite loop (detects maxSteps or cyclic recursion bounds).
- **Read/Write Masks**: Nodes only see the data they are explicitly granted access to via strict object filtering (`_context`).
- **Zero-Boilerplate Human-in-the-Loop (HITL)**: Seamlessly interrupt workflows for manual approval or additional input with safe thread serialization.
- **Tool Agnostic**: First-class support for local Bash scripts, remote Model Context Protocol (MCP), and standard JavaScript functions.


## 📊 Live Fan-Out / Fan-In Example
Run the following command:
```bash
npx tsx examples/run.ts
```

Just change the constants at the top of examples/run.ts to use your own LLM model setup!

```text
🚀 Initializing Project Auto-Summarizer Task Harness...
✅ Validation Passed: DAG, transitions, and system variables match contract constraints.
   [POOL_ALLOCATE] ⚙️ Spawning thread worker for src/agentManager.ts (Active concurrent processes: 1/4)
   [POOL_ALLOCATE] ⚙️ Spawning thread worker for src/dataReplay.ts (Active concurrent processes: 2/4)
   [POOL_ALLOCATE] ⚙️ Spawning thread worker for src/engine.ts (Active concurrent processes: 3/4)
   [POOL_ALLOCATE] ⚙️ Spawning thread worker for src/evals/comparator.ts (Active concurrent processes: 4/4)
   [POOL_RELEASE]  ✔️ Thread worker complete for src/engine.ts
   ...
   [POOL_RELEASE]  ✔️ Thread worker complete for src/workflowValidator.ts

===============================================================================
🏁 PIPELINE COMPLETED SUCCESSFULLY: FINAL AGGREGATE SYSTEM INSIGHTS
===============================================================================
Based on the individual file summaries, I'll provide a comprehensive, high-level project overview mapping out the systemic architecture:

**Project Overview**
The project is an AI Harness platform designed to manage workflow transitions based on a provided schema and observability. The platform consists of several modules that work together to provide universal schema-driven routing, dynamic graph compilation, and data replay capabilities.

**Systemic Architecture**

1. **Workflow Compilation**
        * `src/engine.ts`: Provides functions and classes for building a universal schema-driven router (`createUniversalRouter`) and a dynamic graph compiler (`createWorkflowGraph`).
        * `src/schemaDefinitions.ts`: Defines the schema for a workflow automation system, including agent configurations, orchestration providers, action definitions, verification definitions, state transition rules, and workflow settings.
2. **Agent Management**
        * `src/agentManager.ts`: Provides a registry for pre-instantiated AI agents, allowing their retrieval and management through a `defineAgent` method and a `getAgent` getter.
3. **Data Replay and Evaluation**
        * `src/dataReplay.ts`: Exports interfaces `TapeSnapshot` and `ITapeStorage`, defining a data model for recording and managing workflow execution history.
        * `src/evals/loader.ts`: Retrieves and loads tape evaluations from an external storage provider, returning an array of `EvalStep` objects containing thread ID, step number, and corresponding tape snapshots.
        * `src/evals/runEval.ts`: Runs a series of evaluations on a workflow's steps by replaying the transaction tape, comparing tool outputs with re-run node logic, and reporting evaluation results.
4. **Observability and Monitoring**
        * `src/observer.ts`: Exports interfaces `NodeResult` and `WorkflowObserver`, allowing various backends to monitor AI Harness execution.
5. **Utility Modules and Types**
        * `src/index.ts`: Exports various utility modules and types from other files, with a primary focus on exporting and typing functions related to workflow compilation and execution.
6. **Tool Registry and Validation**
        * `src/toolRegistry.ts`: Provides a centralized registry for user-provided tools that can be invoked by the framework.
        * `src/workflowValidator.ts`: Validates workflow schemas against specified integrity rules, including basic structure checks, node validation, and directed acyclic graph (DAG) consistency.

**Key Components**
1. **Universal Schema-Driven Router**: Built using functions and classes from `src/engine.ts`, this component enables building a universal schema-driven router for managing workflow transitions.
2. **Dynamic Graph Compiler**: Also built using functions and classes from `src/engine.ts`, this component compiles dynamic graphs based on the provided schema.
3. **Agent Registry**: Provided by `src/agentManager.ts`, this registry allows retrieval and management of pre-instantiated AI agents.
4. **Data Replay and Evaluation**: Utilizes interfaces and types from `src/dataReplay.ts` and `src/evals/loader.ts` to record and manage workflow execution history, as well as evaluate tool outputs against re-run node logic.
```

## 📚 Resources
   - Looking to contribute? Check out our [Contributing Guidelines](CONTRIBUTING.md).
   - Curious about the core engine design? Read the [Architecture Deep-Dive](ARCHITECTURE.md).

## License
Apache-2.0