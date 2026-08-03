# NorthBridge Company Cloud Architecture

## Target Topology

```text
NorthBridge-Chat / framework clients / operators
                    |
          HTTPS + restricted ingress
                    |
          AWS ALB (Agent Card + /a2a/*)
          public discovery | Bearer RBAC
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
The Agent Card is public only at the HTTP-auth layer so A2A discovery works;
ALB CIDRs/Tailscale still restrict network ingress, and every `/a2a/*` transport
request requires an authenticated operator Bearer key.

## AWS Contract Implemented Here

- ALB forwards `/.well-known/agent-card.json` and `/a2a/*` to the core target group.
- ECS derives `A2A_PUBLIC_URL` from the HTTPS deployment domain.
- `a2a_enabled` is an explicit rollback control and is forced off without ACM-backed HTTPS.
- Participant cap, deadline, provider/documentation URLs, and remote allowlist are Terraform variables.
- ALB idle timeout is derived from two participant deadlines plus a safety margin so
  synchronous participant and synthesis phases do not lose their client connection.
- Remote Bearer tokens are an arbitrary sensitive map merged into the existing Secrets
  Manager module and injected into ECS by ARN.
- Core fails closed in production when MongoDB-backed task state is unhealthy.
- Redis pub/sub fans cancellation to the replica that owns the active execution; an
  unhealthy coordination plane leaves the durable task unchanged instead of reporting
  a false cancellation.
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
4. Participants work concurrently under a read-only policy enforced at both tool
   advertisement and execution dispatch, with independent deadlines.
5. Contributions are persisted as artifacts and synthesized by Reviewer or Strategist.
6. The terminal task, history, and final artifact remain queryable by the owning operator.
7. Any requested mutations continue through YClaw's action safety and approval paths.

## Release Gate

- `npm run build`, `npm run lint`, focused A2A/security tests, config validation,
  and Terraform validation must be green.
- Linux PR CI must pass the complete root test suite. On Windows, the current
  acceptance evidence is 1,868/1,892 root tests; 24 upstream POSIX-only path,
  executable-bit, bash/grep, and timeout expectations are explicitly excluded.
- Agent Card advertises the intended HTTPS URLs and Bearer security scheme.
- Unauthorized transports return 401/403; an authorized read-only collaboration completes.
- Restarting core preserves task retrieval and operator isolation.
- Cancellation produces a canceled terminal state with the correct task/context IDs.
- One allowlisted remote A2A server is exercised end-to-end with a synthetic, non-sensitive problem.
- Human operators confirm Mission Control approval and incident visibility before production sign-off.
