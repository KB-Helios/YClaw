import { Role, TaskState } from '@a2a-js/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteAgentRegistry, parseRemoteAgents } from '../src/a2a/remote.js';

function registryReturning(result: unknown) {
  const registry = new RemoteAgentRegistry([{
    id: 'partner',
    url: 'https://partner.example.com',
  }]);
  (registry as any).factory = {
    createFromUrl: vi.fn(async () => ({
      sendMessage: vi.fn(async () => result),
    })),
  };
  return registry;
}

describe('A2A remote-agent configuration', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('parses an allowlist with named secret references', () => {
    process.env.NODE_ENV = 'production';

    expect(parseRemoteAgents(JSON.stringify([{
      id: 'partner-research',
      url: 'https://partner.example.com/',
      tokenEnv: 'A2A_PARTNER_TOKEN',
    }]))).toEqual([{
      id: 'partner-research',
      url: 'https://partner.example.com',
      tokenEnv: 'A2A_PARTNER_TOKEN',
    }]);
  });

  it('rejects duplicate IDs and plaintext HTTP in production', () => {
    process.env.NODE_ENV = 'production';

    expect(() => parseRemoteAgents(JSON.stringify([
      { id: 'same', url: 'https://one.example.com' },
      { id: 'same', url: 'https://two.example.com' },
    ]))).toThrow('Duplicate remote A2A agent id');
    expect(() => parseRemoteAgents(JSON.stringify([
      { id: 'insecure', url: 'http://agent.example.com' },
    ]))).toThrow('must use HTTPS');
  });

  it('accepts only completed remote tasks and tolerates omitted collections', async () => {
    const completed = registryReturning({
      id: 'remote-task',
      contextId: 'context',
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      artifacts: undefined,
      history: undefined,
      metadata: undefined,
    });

    await expect(completed.run(
      'partner', 'problem', 'context', new AbortController().signal,
    )).resolves.toEqual({
      id: 'partner',
      output: 'Remote task remote-task completed without text artifacts.',
    });

    const working = registryReturning({
      id: 'remote-task',
      contextId: 'context',
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [],
      metadata: undefined,
    });
    await expect(working.run(
      'partner', 'problem', 'context', new AbortController().signal,
    )).rejects.toThrow('non-completed state');
  });

  it('bounds immediate remote message output', async () => {
    const registry = registryReturning({
      messageId: 'remote-message',
      contextId: 'context',
      taskId: '',
      role: Role.ROLE_AGENT,
      parts: [{
        content: { $case: 'text', value: 'x'.repeat(120_000) },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    });

    const result = await registry.run(
      'partner', 'problem', 'context', new AbortController().signal,
    );
    expect(result.output).toHaveLength(100_000);
  });
});
