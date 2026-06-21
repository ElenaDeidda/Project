# ASA Project — Deliveroo.js Autonomous Agent

A dual-agent player for the [Deliveroo.js](https://github.com/unitn-asa/Deliveroo.js) multi-agent delivery simulation, built for the Autonomous Software Agents course (Unitn). The system pairs a **reactive BDI agent** that handles ordinary parcel pickup/delivery with an **LLM-driven mission agent** that interprets natural-language orders from chat and orchestrates higher-level tactics (team coordination, temporary rule changes, multi-step missions).

## Architecture

`main.js` spawns two independent Node processes (not imports — each needs its own `.env`):

```
main.js
 ├─ bdi/bdi_main.js   → reactive BDI loop (beliefs → options → intentions → plans)
 └─ llm/llm_main.js   → LLM mission planner (chat-driven missions, rules, ReAct-style tool execution)
```

The two processes share state through `beliefs.activeRules` / `beliefs.coord`, which the LLM agent writes to and the BDI loop reads from, so missions can locally override the baseline behavior (e.g. forbid a tile, cap parcel reward, force a relay).

### `bdi/` — reactive delivery agent
| File | Responsibility |
|---|---|
| `bdi_main.js` | Entry point: connects the socket, initializes beliefs, runs the sense–deliberate loop |
| `beliefs.js` | Shared world model (parcels, agents, map, delivery points) with confidence decay |
| `options.js` | Generates candidate pickup/delivery actions, adaptive batch-size heuristic |
| `intentions.js` | Intention revision/deliberation: pushes, stops, and chains plan execution |
| `plans.js` | Plan library (`GoPickUp`, `Deliver`) for standard maps |
| `moves.js` | A* pathfinding and BFS reachability |
| `plan_base.js` | Base class providing the stop/cancel contract for all plans |
| `crates/` | PDDL-based planning for maps with interactive crates |
| `basic_functions.js` | Shared utility helpers (distance, reward/time math) |

### `llm/` — mission planning agent
| File | Responsibility |
|---|---|
| `llm_main.js` | Entry point: loads beliefs/socket, applies active rules, starts the mission listener |
| `llm_agent.js` | Orchestrates the mission queue and admin-only chat listening |
| `mission_queue.js` | Buffers and prioritizes incoming missions, handles preemption |
| `mission_evaluator.js` | Cost/benefit analysis and rule detection (stack size, forbidden tiles, bonus delivery, …) |
| `llm_planner.js` | Understand → plan → (optionally replan on error) pipeline |
| `llm_runner.js` | Runs a mission end-to-end, coordinating long-running team tasks |
| `llm_executor.js` | Executes a mission's tool-call plan step by step |
| `llm_tools.js` | Tool registry exposed to the LLM (inspect, calculate, set_rule, nearest_delivery, …) |
| `llm_parsers.js` | Parses LLM JSON output (intents, plans, final answers) |
| `llm_prompts.js` | Prompt construction for each planning phase |
| `llm_client.js` | LLM API client (OpenAI-compatible / LiteLLM) |
| `llm_messages.js` | Chat message formatting |
| `world_state.js` | Compact text snapshot of beliefs for LLM context |

### `channel/` — team communication & coordination
| File | Responsibility |
|---|---|
| `communication.js` | Team message bus over chat (shout/say), teammate discovery, ask/reply pattern |
| `coordination.js` | State machine for rendezvous, relay handoffs, and red-light synchronization |
| `plans_channel.js` | Concrete plans implementing the coordination tactics above |

## Requirements

- Node.js ≥ 18 (ESM project, `"type": "module"`)
- A running Deliveroo.js server (local or remote) and a valid player token

## Setup

```bash
npm install
```

Each process loads its own env file, so you need three files in the project root:

- `.env` — variables shared by both processes
- `.env.bdi` — BDI-specific overrides
- `.env.llm` — LLM-specific overrides

Key variables:

| Variable | Used by | Purpose |
|---|---|---|
| `HOST` | both | Deliveroo.js server URL |
| `TOKEN` | both | Player auth token |
| `ROLE` | both | Logical role tag (`bdi` / `llm`) used in logs/coordination |
| `LITELLM_BASE_URL` | llm | LLM API endpoint |
| `LITELLM_API_KEY` | llm | LLM API key |
| `LOCAL_MODEL` | llm | Model name to call |
| `TEAM_NAMES` | both (optional) | Comma-separated allowlist for teammate detection |
| `COMMS_DEBUG` | both (optional) | Toggle team-message logging |
| `LLM_LOG_MUTE` | llm (optional) | Comma-separated log tags to silence |


## Running

Run both agents together:

```bash
node main.js
```

Or run a single agent for testing:

```bash
node bdi/bdi_main.js
node llm/llm_main.js
```

## Domain concepts

- **Beliefs** — shared world model (self, parcels, other agents, map, delivery points)
- **Intentions** — the goal currently being pursued (e.g. `['go_pick_up', x, y, id, reward]`)
- **Missions** — natural-language orders sent via chat that the LLM agent parses and executes
- **Rules (L2)** — persistent behavior modifiers a mission can install (e.g. `forbidden_tiles`, `max_parcel_reward`, `bonus_delivery`) that the BDI loop respects
- **Coordination (L3)** — team tactics: rendezvous, relay handoff, red-light synchronization
- **Crates** — interactive map objects that require a PDDL solver to plan pickup/delivery sequences
