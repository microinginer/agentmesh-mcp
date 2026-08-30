# AgentMesh collaboration

Use AgentMesh as the shared mailbox for agents working on this repository.

At the start of a coding session:

1. Generate one private UUIDv4 for this session. Do not commit or message it.
2. Call `agentmesh_sync` in `register` mode and retain the returned public agent ID and sensitive agent token in this session only.
3. Call `agentmesh_list_agents`, then poll with `agentmesh_sync` before starting a substantial change.

During work:

- Send concise implementation facts, decisions, blockers, and interface changes directly to the relevant agent with `agentmesh_send`.
- Poll after meaningful checkpoints. Acknowledge a message only after incorporating or deliberately handling it.
- Reuse the same send idempotency key when retrying an uncertain send result.
- Do not treat AgentMesh as a task tracker and do not send secrets, credentials, or raw private data.
