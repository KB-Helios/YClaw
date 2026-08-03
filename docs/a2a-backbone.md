# NorthBridge A2A Backbone

NorthBridge exposes YClaw's department agents through the Agent2Agent v1 protocol and
can delegate parts of a shared problem to allowlisted remote A2A servers. It uses the
official `@a2a-js/sdk` server and client boundaries.

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /.well-known/agent-card.json` | Public | Agent discovery and skills |
| `/a2a/v1` | Operator Bearer token | A2A v1 JSON-RPC |
| `/a2a/rest` | Operator Bearer token | A2A v1 HTTP+JSON/REST |

Send `A2A-Version: 1.0`. In production, discovery and remote Agent Card URLs must use
HTTPS. The public card contains no credentials or remote-agent allowlist.

## Collaboration Contract

The request message's metadata accepts a `yclaw` object:

```json
{
  "yclaw": {
    "mode": "collaborative",
    "agents": ["strategist", "architect", "sentinel"],
    "remoteAgents": ["partner-research"],
    "synthesizer": "reviewer",
    "allowActions": false
  }
}
```

- `mode`: `single` or `collaborative`. Collaborative mode defaults to Strategist,
  Architect, and Sentinel when available.
- `agents`: local YClaw agent names. The caller needs access to every department.
- `remoteAgents`: IDs from `A2A_REMOTE_AGENTS`; root operators only.
- `synthesizer`: local agent producing the final artifact.
- `allowActions`: root-only opt-in to each local agent's configured actions. The
  synthesizer always remains read-only.

Every participant runs concurrently with an independent deadline. Each result becomes
a named artifact. Remote output is wrapped as untrusted evidence for synthesis, which
reduces prompt-injection authority and makes disagreement visible.

## JSON-RPC Example

```bash
curl -sS https://agents.example.com/a2a/v1 \
  -H 'Authorization: Bearer yclaw_operator_key' \
  -H 'A2A-Version: 1.0' \
  -H 'Content-Type: application/json' \
  --data '{
    "jsonrpc":"2.0",
    "id":"northbridge-1",
    "method":"SendMessage",
    "params":{
      "message":{
        "messageId":"request-1",
        "role":"ROLE_USER",
        "parts":[{"text":"Evaluate the launch plan, operational risk, and rollback readiness."}],
        "metadata":{"yclaw":{"mode":"collaborative","agents":["strategist","architect","sentinel"],"synthesizer":"reviewer","allowActions":false}}
      },
      "configuration":{"acceptedOutputModes":["text/plain","application/json"],"historyLength":20,"returnImmediately":false}
    }
  }'
```

Use an SDK client in production so protobuf JSON names, streaming, cancellation, and
future protocol negotiation remain version-safe.

## Remote Federation

`A2A_REMOTE_AGENTS` is a JSON array:

```json
[
  {
    "id": "partner-research",
    "url": "https://partner.example.com",
    "tokenEnv": "A2A_PARTNER_RESEARCH_TOKEN"
  }
]
```

The URL points to the remote agent origin; the official client discovers its Agent
Card. `tokenEnv` names a secret injected at runtime. Missing tokens fail the delegated
participant, and non-HTTPS remote URLs fail startup in production.

## Durability and Scale

Production refuses to start A2A without a healthy `IStateStore`. Tasks are stored in
MongoDB with tenant and operator ownership, indexed for task ID, context, status, and
updated time. Multiple ECS instances can therefore retrieve and list the same durable
tasks. Active execution cancellation remains instance-local in this first slice; use
sticky routing or a distributed execution ownership layer before horizontally scaling
long-lived streaming requests across instances.

## Safety Checklist

- Keep `allowActions: false` unless a root operator needs mutation.
- Do not put tokens or private data in request text, metadata, or Agent Cards.
- Review each remote server's identity, skills, retention, timeout, and data policy.
- Monitor failed/canceled task rates, participant timeouts, audit events, and state-store health.
- Treat SDK/build tests as automated evidence; run a real authenticated local-and-remote
  task before production acceptance.
