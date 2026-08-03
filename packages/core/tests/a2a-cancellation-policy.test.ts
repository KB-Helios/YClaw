import { DefaultExecutionEventBus } from '@a2a-js/sdk/server';
import { describe, expect, it, vi } from 'vitest';

import type { AgentContext } from '../src/bootstrap/agents.js';
import { YClawA2AExecutor } from '../src/a2a/executor.js';

function executor() {
  return new YClawA2AExecutor({
    router: {
      getAllConfigs: () => new Map(),
      getConfig: () => undefined,
    },
    executor: { execute: vi.fn() },
  } as unknown as AgentContext);
}

describe('YClaw A2A cancellation policy', () => {
  it('does not start a participant after its parent signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already canceled'));
    const operation = vi.fn(async () => 'should not run');

    await expect((executor() as any).withTimeout(
      controller.signal,
      operation,
    )).rejects.toThrow('already canceled');
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not publish cancellation for a task not owned by this executor', async () => {
    const eventBus = new DefaultExecutionEventBus();
    const events: unknown[] = [];
    eventBus.on('event', (event) => events.push(event));

    await expect(executor().cancelTask('not-local', eventBus))
      .rejects.toThrow('No locally owned running A2A task');
    expect(events).toEqual([]);
  });
});
