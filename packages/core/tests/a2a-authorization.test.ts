import { Role, TaskState } from '@a2a-js/sdk';
import { DefaultExecutionEventBus, RequestContext, ServerCallContext } from '@a2a-js/sdk/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentContext } from '../src/bootstrap/agents.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { OperatorTier } from '../src/operators/types.js';
import { A2AOperatorUser } from '../src/a2a/auth.js';
import { YClawA2AExecutor } from '../src/a2a/executor.js';
import { OperatorSchema } from '../src/operators/types.js';

function config(name: string, department: AgentConfig['department']): AgentConfig {
  return {
    name,
    department,
    description: `${name} description`,
    model: { provider: 'anthropic', model: 'test', temperature: 0, maxTokens: 100 },
    system_prompts: [],
    triggers: [],
    actions: [],
    data_sources: [],
    event_subscriptions: [],
    event_publications: [],
    review_bypass: [],
    communication: {},
    executor: {},
  };
}

function operator(tier: OperatorTier, departments: string[]) {
  return OperatorSchema.parse({
    operatorId: `${tier}-operator`,
    displayName: tier,
    role: tier,
    email: `${tier}@northbridge.test`,
    apiKeyHash: 'hash',
    apiKeyPrefix: 'prefix',
    tier,
    departments,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function run(
  metadata: Record<string, unknown>,
  actor = operator('root', ['*']),
  remotes?: { has(id: string): boolean },
) {
  const configs = new Map([
    ['strategist', config('strategist', 'executive')],
    ['architect', config('architect', 'development')],
    ['sentinel', config('sentinel', 'operations')],
    ['reviewer', config('reviewer', 'executive')],
  ]);
  const execute = vi.fn(async (agent: AgentConfig, _task: string, trigger: string) => ({
    executionId: `${agent.name}-${trigger}`,
    agentName: agent.name,
    trigger,
    status: 'completed',
    startedAt: new Date(),
    completedAt: new Date(),
    actionsTaken: [],
    output: 'ok',
  }));
  const agents = {
    router: {
      getAllConfigs: () => configs,
      getConfig: (name: string) => configs.get(name),
    },
    executor: { execute },
  } as unknown as AgentContext;
  const requestContext = new RequestContext({
    tenant: 'northbridge',
    message: {
      messageId: 'authorization-message',
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: 'text', value: 'Authorize this task.' },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      }],
      metadata: { yclaw: metadata },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  }, 'authorization-task', 'authorization-context', new ServerCallContext({
    tenant: 'northbridge',
    user: new A2AOperatorUser(actor),
    requestedVersion: '1.0',
  }));
  const eventBus = new DefaultExecutionEventBus();
  const events: Array<{ kind: string; data: any }> = [];
  eventBus.on('event', (event) => events.push(event));

  await new YClawA2AExecutor(agents, remotes as any).execute(requestContext, eventBus);
  const final = events.filter((event) => event.kind === 'statusUpdate').at(-1)?.data.status;
  const part = final?.message?.parts?.[0];
  const message = part?.content?.$case === 'text' ? part.content.value : '';
  return { execute, final, message };
}

describe('YClaw A2A authorization branches', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects operators below contributor tier', async () => {
    const result = await run({}, operator('observer', ['executive']));
    expect(result.final?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(result.message).toContain('contributor tier');
    expect(result.execute).not.toHaveBeenCalled();
  });

  it('restricts configured action tools to root operators', async () => {
    const result = await run(
      { agents: ['strategist'], allowActions: true },
      operator('contributor', ['executive']),
    );
    expect(result.final?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(result.message).toContain('Only root operators');
  });

  it('enforces local-agent department scope', async () => {
    const result = await run(
      { agents: ['architect'] },
      operator('contributor', ['marketing']),
    );
    expect(result.final?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(result.message).toContain('cannot access development agent architect');
  });

  it('checks root authority before revealing remote-agent membership', async () => {
    const result = await run(
      { agents: ['strategist'], remoteAgents: ['secret-partner'] },
      operator('contributor', ['executive']),
      { has: () => false },
    );
    expect(result.final?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(result.message).toBe('Remote A2A delegation requires a root operator');
    expect(result.message).not.toContain('secret-partner');
  });

  it('enforces the combined local and remote participant limit', async () => {
    process.env.A2A_MAX_PARTICIPANTS = '1';
    const result = await run({ agents: ['strategist', 'architect'] });
    expect(result.final?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(result.message).toContain('exceeds the 1 participant limit');
  });
});
