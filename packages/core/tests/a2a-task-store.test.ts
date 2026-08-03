import { Role, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '@a2a-js/sdk';
import type { IStateStore } from '../src/interfaces/IStateStore.js';
import { OperatorSchema } from '../src/operators/types.js';
import { A2AOperatorUser } from '../src/a2a/auth.js';
import { PersistentA2ATaskStore } from '../src/a2a/task-store.js';

function operator(operatorId: string) {
  return OperatorSchema.parse({
    operatorId,
    displayName: operatorId,
    role: 'operator',
    email: `${operatorId}@northbridge.test`,
    apiKeyHash: 'hash',
    apiKeyPrefix: 'prefix',
    tier: 'contributor',
    departments: ['development'],
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function context(operatorId: string, tenant = 'northbridge') {
  return new ServerCallContext({
    tenant,
    user: new A2AOperatorUser(operator(operatorId)),
    requestedVersion: '1.0',
  });
}

function task(id: string): Task {
  return {
    id,
    contextId: 'shared-context',
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      message: undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [{
      messageId: `${id}-message`,
      contextId: 'shared-context',
      taskId: id,
      role: Role.ROLE_USER,
      parts: [],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    }],
    metadata: undefined,
  };
}

describe('Persistent A2A task store', () => {
  it('upserts durable tasks and isolates them by tenant and operator', async () => {
    const documents: Array<Record<string, any>> = [];
    const collection = {
      createIndex: vi.fn(async () => 'index'),
      findOne: vi.fn(async (filter: Record<string, unknown>) => documents.find((document) => (
        Object.entries(filter).every(([key, value]) => document[key] === value)
      )) ?? null),
      updateOne: vi.fn(async (
        filter: Record<string, unknown>,
        update: Record<string, Record<string, any>>,
        options?: { upsert?: boolean },
      ) => {
        const index = documents.findIndex((document) => (
          Object.entries(filter).every(([key, value]) => document[key] === value)
        ));
        if (index >= 0) {
          documents[index] = { ...documents[index], ...structuredClone(update.$set ?? {}) };
        } else if (options?.upsert) {
          documents.push({
            ...structuredClone(filter),
            ...structuredClone(update.$setOnInsert ?? {}),
            ...structuredClone(update.$set ?? {}),
          });
        }
        return { acknowledged: true, matchedCount: index >= 0 ? 1 : 0, modifiedCount: 1 };
      }),
      find: vi.fn(async (filter: Record<string, unknown>, options?: { skip?: number; limit?: number }) => {
        const matches = documents.filter((document) => Object.entries(filter).every(([key, value]) => (
          typeof value === 'object' ? true : document[key] === value
        )));
        const start = options?.skip ?? 0;
        return matches.slice(start, start + (options?.limit ?? matches.length));
      }),
      countDocuments: vi.fn(async (filter: Record<string, unknown>) => documents.filter((document) => (
        Object.entries(filter).every(([key, value]) => (
          typeof value === 'object' ? true : document[key] === value
        ))
      )).length),
    };
    const stateStore = {
      collection: () => collection,
    } as unknown as IStateStore;
    const store = new PersistentA2ATaskStore(stateStore);
    await store.initialize();

    await store.save(task('task-1'), context('alice'));

    expect(await store.load('task-1', context('alice'))).toEqual(expect.objectContaining({ id: 'task-1' }));
    expect(await store.load('task-1', context('bob'))).toBeUndefined();
    expect(await store.load('task-1', context('alice', 'other-tenant'))).toBeUndefined();
    expect(collection.updateOne).toHaveBeenCalledWith(
      { tenant: 'northbridge', owner: 'alice', id: 'task-1' },
      expect.objectContaining({ $set: expect.any(Object), $setOnInsert: expect.any(Object) }),
      { upsert: true },
    );
  });
});
