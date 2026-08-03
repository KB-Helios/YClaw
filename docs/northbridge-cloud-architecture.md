# NorthBridge Company Cloud Architecture

## Target Topology

```text
NorthBridge-Chat / framework clients / operators
                    |
              HTTPS + Bearer RBAC
                    |
          AWS ALB (Agent Card + /a2a/*)
                    |
             YClaw Core on ECS
        +-----------+-----------+
        |           |           |
      MongoDB     Redis      PostgreSQL
   tasks/audit   events      agent memory
        |
       S3 artifacts          AO workers / GitHub
                    |
        allowlisted remote A2A servers
```

Mission Control is the human approval and observability surface. Core owns authority,
task lifecycle, local agent execution, synthesis, and audit. AO owns isolated codegen
workspaces. Databases, Redis, and AO remain private; only ALB-routed HTTP surfaces are
reachable from allowed ingress networks.

## AWS Contract Implemented Here

- ALB forwards `/.well-known/agent-card.json` and `/a2a/*` to the core target group.
- ECS derives `A2A_PUBLIC_URL` from the HTTPS deployment domain.
- Participant cap, deadline, provider URL, and remote allowlist are Terraform variables.
- Remote Bearer tokens are an arbitrary sensitive map merged into the existing Secrets
  Manager module and injected into ECS by ARN.
- Core fails closed in production when MongoDB-backed task state is unhealthy.
- Standard `/health` remains the ECS target health check; production acceptance should
  additionally probe the Agent Card and an authenticated no-action task.

## Deployment Inputs

Use `deploy/aws/terraform.tfvars.example` as the non-secret template. Production needs:

1. A domain and matching ACM certificate; A2A production discovery rejects HTTP.
2. `KB-Helios/NorthBridge-Chat` and `KB-Helios/YClaw` in `yclaw_repos`.
3. Root operator, event-bus, AO, GitHub App, LLM, database, and remote-agent secrets from protected inputs.
4. Explicit ingress CIDRs or Tailscale policy for every A2A caller.
5. Remote definitions in `a2a_remote_agents` and matching token keys in
   `a2a_remote_agent_secrets`.

## Company Automation Flow

1. An operator or NorthBridge-Chat submits a company problem through A2A.
2. RBAC validates operator tier and department scope.
3. Strategist or the request metadata chooses local and remote participants.
4. Participants work concurrently under read-only policy and independent deadlines.
5. Contributions are persisted as artifacts and synthesized by Reviewer or Strategist.
6. The terminal task, history, and final artifact remain queryable by the owning operator.
7. Any requested mutations continue through YClaw's action safety and approval paths.

## Release Gate

- `npm run build`, `npm run lint`, `npm test`, config validation, and Terraform validation are green.
- Agent Card advertises the intended HTTPS URLs and Bearer security scheme.
- Unauthorized transports return 401/403; an authorized read-only collaboration completes.
- Restarting core preserves task retrieval and operator isolation.
- Cancellation produces a canceled terminal state with the correct task/context IDs.
- One allowlisted remote A2A server is exercised end-to-end with a synthetic, non-sensitive problem.
- Human operators confirm Mission Control approval and incident visibility before production sign-off.
