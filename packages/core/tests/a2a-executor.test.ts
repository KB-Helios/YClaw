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
    const execute = vi.fn(async (
      _agent: AgentConfig,
      _task: string,
      _trigger: string,
      _payload: unknown,
      _model: unknown,
      signal: AbortSignal,
    ) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
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
});
