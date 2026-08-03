import { DefaultExecutionEventBus, RequestContext, ServerCallContext } from '@a2a-js/sdk/server';
import { Role, TaskState } from '@a2a-js/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentContext } from '../src/bootstrap/agents.js';
import type { AgentConfig } from '../src/config/schema.js';
import { OperatorSchema } from '../src/operators/types.js';
import { A2AOperatorUser } from '../src/a2a/auth.js';
import { YClawA2AExecutor } from '../src/a2a/executor.js';

function config(name: string, department: AgentConfig['department']): AgentConfig {
  return {
    name,
    department,
    description: `${name} description`,
    model: { provider: 'anthropic', model: 'test', temperature: 0, maxTokens: 100 },
    system_prompts: [],
    triggers: [],
    actions: ['github:create_issue'],
    data_sources: [],
    event_subscriptions: [],
    event_publications: [],
    review_bypass: [],
    communication: {},
    executor: {},
  };
}

describe('YClaw A2A executor', () => {
  it('runs message-selected agents concurrently, emits artifacts, and synthesizes read-only', async () => {
    const configs = new Map([
      ['strategist', config('strategist', 'executive')],
      ['architect', config('architect', 'development')],
      ['sentinel', config('sentinel', 'operations')],
      ['reviewer', config('reviewer', 'executive')],
    ]);
    let activeParticipants = 0;
    let maxActiveParticipants = 0;
    const execute = vi.fn(async (agent: AgentConfig, _task: string, trigger: string) => {
      if (trigger === 'a2a') {
        activeParticipants += 1;
        maxActiveParticipants = Math.max(maxActiveParticipants, activeParticipants);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeParticipants -= 1;
      }
      return {
        executionId: `${agent.name}-execution`,
        agentName: agent.name,
        trigger,
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        actionsTaken: [],
        output: trigger === 'a2a_synthesis' ? 'synthesized answer' : `${agent.name} evidence`,
      };
    });
    const agents = {
      router: {
        getAllConfigs: () => configs,
        getConfig: (name: string) => configs.get(name),
      },
      executor: { execute },
    } as unknown as AgentContext;
    const operator = OperatorSchema.parse({
      operatorId: 'root-operator',
      displayName: 'Root',
      role: 'owner',
      email: 'root@northbridge.test',
      apiKeyHash: 'hash',
      apiKeyPrefix: 'prefix',
      tier: 'root',
      departments: ['*'],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const request = {
      tenant: 'northbridge',
      message: {
        messageId: 'message-1',
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [{
          content: { $case: 'text' as const, value: 'Assess launch readiness.' },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        }],
        metadata: {
          yclaw: {
            mode: 'collaborative',
            agents: ['strategist', 'architect', 'sentinel'],
            synthesizer: 'reviewer',
            allowActions: false,
          },
        },
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    };
    const callContext = new ServerCallContext({
      tenant: 'northbridge',
      user: new A2AOperatorUser(operator),
      requestedVersion: '1.0',
    });
    const requestContext = new RequestContext(request, 'task-1', 'context-1', callContext);
    const eventBus = new DefaultExecutionEventBus();
    const events: Array<{ kind: string; [key: string]: unknown }> = [];
    eventBus.on('event', (event) => events.push(event));

    await new YClawA2AExecutor(agents).execute(requestContext, eventBus);

    expect(maxActiveParticipants).toBe(3);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls.every((call) => call[8] === 'read_only')).toBe(true);
    expect(events[0]?.kind).toBe('task');
    expect(events.filter((event) => event.kind === 'artifactUpdate')).toHaveLength(4);
    const finalStatus = events.filter((event) => event.kind === 'statusUpdate').at(-1);
    expect(finalStatus?.data).toEqual(expect.objectContaining({
      taskId: 'task-1',
      contextId: 'context-1',
      status: expect.objectContaining({
      state: TaskState.TASK_STATE_COMPLETED,
      }),
    }));
  });

  it('keeps cancellation terminal and preserves the task context ID', async () => {
    const configs = new Map([
      ['strategist', config('strategist', 'executive')],
      ['reviewer', config('reviewer', 'executive')],
    ]);
    // Simulate a provider that ignores AbortSignal. The A2A timeout wrapper must
    // still let cancellation return promptly, while AgentExecutor's post-chat
    // guard prevents later tool execution in the real execution path.
    const execute = vi.fn(async () => new Promise(() => {}));
    const agents = {
      router: {
        getAllConfigs: () => configs,
        getConfig: (name: string) => configs.get(name),
      },
      executor: { execute },
    } as unknown as AgentContext;
    const operator = OperatorSchema.parse({
      operatorId: 'root-operator',
      displayName: 'Root',
      role: 'owner',
      email: 'root@northbridge.test',
      apiKeyHash: 'hash',
      apiKeyPrefix: 'prefix',
      tier: 'root',
      departments: ['*'],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const requestContext = new RequestContext({
      tenant: 'northbridge',
      message: {
        messageId: 'message-cancel',
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [{
          content: { $case: 'text', value: 'Wait for cancellation.' },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    }, 'task-cancel', 'context-cancel', new ServerCallContext({
      tenant: 'northbridge',
      user: new A2AOperatorUser(operator),
      requestedVersion: '1.0',
    }));
    const eventBus = new DefaultExecutionEventBus();
    const events: Array<{ kind: string; data: any }> = [];
    eventBus.on('event', (event) => events.push(event));
    const executor = new YClawA2AExecutor(agents);

    const running = executor.execute(requestContext, eventBus);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await executor.cancelTask('task-cancel', eventBus);
    await running;

    const terminalStates = events
      .filter((event) => event.kind === 'statusUpdate')
      .map((event) => event.data.status.state)
      .filter((state) => [
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_CANCELED,
      ].includes(state));
    expect(terminalStates).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(events.find((event) => event.data.status?.state === TaskState.TASK_STATE_CANCELED)?.data)
      .toEqual(expect.objectContaining({
        taskId: 'task-cancel',
        contextId: 'context-cancel',
      }));
  });

  it('falls back to an authorized local synthesizer for a department-scoped operator', async () => {
    const configs = new Map([
      ['architect', config('architect', 'development')],
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
      output: `${agent.name} output`,
    }));
    const agents = {
      router: {
        getAllConfigs: () => configs,
        getConfig: (name: string) => configs.get(name),
      },
      executor: { execute },
    } as unknown as AgentContext;
    const operator = OperatorSchema.parse({
      operatorId: 'development-operator',
      displayName: 'Development',
      role: 'contributor',
      email: 'development@northbridge.test',
      apiKeyHash: 'hash',
      apiKeyPrefix: 'prefix',
      tier: 'contributor',
      departments: ['development'],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const requestContext = new RequestContext({
      tenant: 'northbridge',
      message: {
        messageId: 'message-development',
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [{
          content: { $case: 'text', value: 'Review the architecture.' },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        }],
        metadata: { yclaw: { agents: ['architect'], allowActions: false } },
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    }, 'task-development', 'context-development', new ServerCallContext({
      tenant: 'northbridge',
      user: new A2AOperatorUser(operator),
      requestedVersion: '1.0',
    }));
    const eventBus = new DefaultExecutionEventBus();
    const events: Array<{ kind: string; data: any }> = [];
    eventBus.on('event', (event) => events.push(event));

    const rateLimiter = {
      incrementConcurrent: vi.fn().mockResolvedValue(1),
      incrementDaily: vi.fn().mockResolvedValue(1),
      decrementConcurrent: vi.fn().mockResolvedValue(0),
    };
    await new YClawA2AExecutor(agents, undefined, rateLimiter as any)
      .execute(requestContext, eventBus);

    expect(execute.mock.calls.map((call) => call[0].name)).toEqual(['architect', 'architect']);
    expect(rateLimiter.incrementConcurrent).toHaveBeenCalledWith('development-operator');
    expect(rateLimiter.incrementDaily).toHaveBeenCalledWith('development-operator');
    expect(rateLimiter.decrementConcurrent).toHaveBeenCalledWith('development-operator');
    expect(events.filter((event) => event.kind === 'statusUpdate').at(-1)?.data.status.state)
      .toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it('bounds aggregate participant evidence before synthesis', async () => {
    const configs = new Map([
      ['strategist', config('strategist', 'executive')],
      ['architect', config('architect', 'development')],
      ['reviewer', config('reviewer', 'executive')],
    ]);
    const execute = vi.fn(async (agent: AgentConfig, task: string, trigger: string) => ({
      executionId: `${agent.name}-${trigger}`,
      agentName: agent.name,
      trigger,
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      actionsTaken: [],
      output: trigger === 'a2a_synthesis' ? 'bounded synthesis' : 'x'.repeat(150_000),
      task,
    }));
    const agents = {
      router: {
        getAllConfigs: () => configs,
        getConfig: (name: string) => configs.get(name),
      },
      executor: { execute },
    } as unknown as AgentContext;
    const operator = OperatorSchema.parse({
      operatorId: 'root-operator', displayName: 'Root', role: 'owner',
      email: 'root@northbridge.test', apiKeyHash: 'hash', apiKeyPrefix: 'prefix',
      tier: 'root', departments: ['*'], status: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    });
    const requestContext = new RequestContext({
      tenant: 'northbridge',
      message: {
        messageId: 'message-bounds', contextId: '', taskId: '', role: Role.ROLE_USER,
        parts: [{
          content: { $case: 'text', value: 'Bound the evidence.' },
          metadata: undefined, filename: '', mediaType: 'text/plain',
        }],
        metadata: { yclaw: { agents: ['strategist', 'architect'], synthesizer: 'reviewer' } },
        extensions: [], referenceTaskIds: [],
      },
      configuration: undefined, metadata: undefined,
    }, 'task-bounds', 'context-bounds', new ServerCallContext({
      tenant: 'northbridge', user: new A2AOperatorUser(operator), requestedVersion: '1.0',
    }));

    await new YClawA2AExecutor(agents).execute(
      requestContext,
      new DefaultExecutionEventBus(),
    );

    const synthesisTask = execute.mock.calls.find((call) => call[2] === 'a2a_synthesis')?.[1];
    expect(synthesisTask).toBeDefined();
    expect(synthesisTask!.length).toBeLessThan(110_000);
    const evidenceMarkers = synthesisTask!.match(/a2a-evidence-[0-9a-f-]{36}/g) ?? [];
    expect(evidenceMarkers).toHaveLength(3);
    expect(new Set(evidenceMarkers).size).toBe(1);
    expect(synthesisTask).not.toContain('<participant_evidence>');
  });

  it('fans a non-local cancellation out through the healthy coordination bus', async () => {
    const configs = new Map([
      ['strategist', config('strategist', 'executive')],
    ]);
    const agents = {
      router: {
        getAllConfigs: () => configs,
        getConfig: (name: string) => configs.get(name),
      },
      executor: { execute: vi.fn() },
    } as unknown as AgentContext;
    const coordinationBus = {
      subscribe: vi.fn(),
      isHealthy: vi.fn().mockReturnValue(true),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new YClawA2AExecutor(
      agents,
      undefined,
      null,
      coordinationBus as any,
    );

    await executor.coordinateCancellation('task-on-another-replica', {
      tenant: 'northbridge',
      user: { userName: 'root-operator' },
    } as any);

    expect(coordinationBus.publish).toHaveBeenCalledWith(
      'a2a',
      'cancel_request',
      {
        taskId: 'task-on-another-replica',
        tenant: 'northbridge',
        owner: 'root-operator',
      },
    );
  });
});
