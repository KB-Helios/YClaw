import { Role, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { describe, expect, it, vi } from 'vitest';

import type { ListTasksRequest, Task } from '@a2a-js/sdk';
import type { IStateStore } from '../src/interfaces/IStateStore.js';
import { A2AOperatorUser } from '../src/a2a/auth.js';
import { PersistentA2ATaskStore } from '../src/a2a/task-store.js';
import { OperatorSchema } from '../src/operators/types.js';

function matches(document: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') {
      return (expected as Array<Record<string, any>>).some((candidate) => matches(document, candidate));
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const actual = document[key];
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === '$lt') return actual < value;
        if (operator === '$gte') return actual >= value;
        return false;
      });
    }
    return document[key] === expected;
  });
}

function harness() {
  const documents: Array<Record<string, any>> = [];
  const collection = {
    createIndex: vi.fn(async () => 'index'),
    findOne: vi.fn(async (filter: Record<string, any>) => (
      documents.find((document) => matches(document, filter)) ?? null
    )),
    updateOne: vi.fn(async (
      filter: Record<string, any>,
      update: Record<string, Record<string, any>>,
      options?: { upsert?: boolean },
    ) => {
      const index = documents.findIndex((document) => matches(document, filter));
      if (index >= 0) {
        documents[index] = { ...documents[index], ...structuredClone(update.$set ?? {}) };
      } else if (options?.upsert) {
        documents.push({
          ...structuredClone(filter),
          ...structuredClone(update.$setOnInsert ?? {}),
          ...structuredClone(update.$set ?? {}),
        });
      }
      return {
        matchedCount: index >= 0 ? 1 : 0,
        modifiedCount: index >= 0 ? 1 : 0,
      };
    }),
    replaceOne: vi.fn(async (filter: Record<string, any>, replacement: Record<string, any>) => {
      const index = documents.findIndex((document) => matches(document, filter));
      if (index >= 0) documents[index] = structuredClone(replacement);
      else documents.push(structuredClone(replacement));
      return {
        matchedCount: index >= 0 ? 1 : 0,
        modifiedCount: index >= 0 ? 1 : 0,
        upsertedCount: index >= 0 ? 0 : 1,
      };
    }),
    find: vi.fn(async (
      filter: Record<string, any>,
      options?: { sort?: Record<string, 1 | -1>; limit?: number },
    ) => {
      const matchesFilter = documents.filter((document) => matches(document, filter));
      const sorted = matchesFilter.sort((left, right) => {
        for (const [field, direction] of Object.entries(options?.sort ?? {})) {
          if (left[field] === right[field]) continue;
          return (left[field] < right[field] ? -1 : 1) * direction;
        }
        return 0;
      });
      return sorted
        .slice(0, options?.limit ?? sorted.length)
        .map((document) => structuredClone(document));
    }),
    countDocuments: vi.fn(async (filter: Record<string, any>) => (
      documents.filter((document) => matches(document, filter)).length
    )),
  };
  const store = new PersistentA2ATaskStore({
    collection: () => collection,
  } as unknown as IStateStore);
  return { store, documents, collection };
}

function context() {
  const operator = OperatorSchema.parse({
    operatorId: 'alice',
    displayName: 'Alice',
    role: 'operator',
    email: 'alice@northbridge.test',
    apiKeyHash: 'hash',
    apiKeyPrefix: 'prefix',
    tier: 'contributor',
    departments: ['development'],
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return new ServerCallContext({
    tenant: 'northbridge',
    user: new A2AOperatorUser(operator),
    requestedVersion: '1.0',
  });
}

function task(id: string, contextId: string, state: TaskState): Task {
  const message = (suffix: string) => ({
    messageId: `${id}-${suffix}`,
    contextId,
    taskId: id,
    role: Role.ROLE_AGENT,
    parts: [],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  });
  return {
    id,
    contextId,
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [{
      artifactId: `${id}-artifact`,
      name: id,
      description: 'test',
      parts: [],
      metadata: undefined,
      extensions: [],
    }],
    history: [message('one'), message('two')],
    metadata: undefined,
  };
}

function listRequest(overrides: Partial<ListTasksRequest> = {}): ListTasksRequest {
  return {
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageSize: 2,
    pageToken: '',
    historyLength: 1,
    statusTimestampAfter: undefined,
    includeArtifacts: false,
    ...overrides,
  };
}

describe('Persistent A2A task-store pagination', () => {
  it('uses a stable cursor and applies formatting and filters', async () => {
    const { store, documents } = harness();
    await store.initialize();
    await store.save(task('task-1', 'context-a', TaskState.TASK_STATE_COMPLETED), context());
    await store.save(task('task-2', 'context-b', TaskState.TASK_STATE_FAILED), context());
    await store.save(task('task-3', 'context-a', TaskState.TASK_STATE_COMPLETED), context());
    documents.find((document) => document.id === 'task-1')!.updatedAt = '2026-08-01T00:00:00.000Z';
    documents.find((document) => document.id === 'task-2')!.updatedAt = '2026-08-02T00:00:00.000Z';
    documents.find((document) => document.id === 'task-3')!.updatedAt = '2026-08-03T00:00:00.000Z';

    const first = await store.list(listRequest(), context());
    expect(first.tasks.map((item) => item.id)).toEqual(['task-3', 'task-2']);
    expect(first.totalSize).toBe(3);
    expect(first.nextPageToken).not.toBe('');
    expect(first.tasks[0]?.history).toHaveLength(1);
    expect(first.tasks[0]?.artifacts).toEqual([]);

    const second = await store.list(listRequest({ pageToken: first.nextPageToken }), context());
    expect(second.tasks.map((item) => item.id)).toEqual(['task-1']);
    expect(second.nextPageToken).toBe('');
    expect(second.totalSize).toBe(3);

    const filtered = await store.list(listRequest({
      contextId: 'context-a',
      status: TaskState.TASK_STATE_COMPLETED,
      includeArtifacts: true,
    }), context());
    expect(filtered.tasks.map((item) => item.id)).toEqual(['task-3', 'task-1']);
    expect(filtered.tasks[0]?.artifacts).toHaveLength(1);
  });

  it('keeps one durable document under concurrent upserts of the same task', async () => {
    const { store, documents, collection } = harness();
    await store.initialize();

    await Promise.all([
      store.save(task('same-task', 'context-a', TaskState.TASK_STATE_WORKING), context()),
      store.save(task('same-task', 'context-a', TaskState.TASK_STATE_COMPLETED), context()),
    ]);

    expect(documents.filter((document) => document.id === 'same-task')).toHaveLength(1);
    expect(collection.updateOne).toHaveBeenCalledTimes(2);
    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'same-task' }),
      expect.objectContaining({ $set: expect.any(Object), $setOnInsert: expect.any(Object) }),
      { upsert: true },
    );
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(await store.load('same-task', context())).toEqual(expect.objectContaining({ id: 'same-task' }));
  });
});
