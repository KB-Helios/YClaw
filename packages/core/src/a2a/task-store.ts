import { TaskState } from '@a2a-js/sdk';

import type { ListTasksRequest, ListTasksResponse, Task } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import type { ICollection, IStateStore } from '../interfaces/IStateStore.js';

interface A2ATaskDocument extends Record<string, unknown> {
  id: string;
  tenant: string;
  owner: string;
  contextId: string;
  status: TaskState;
  statusTimestamp: string;
  task: Task;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_SCOPE = 'default';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface PageCursor {
  updatedAt: string;
  id: string;
}

function getScope(context: ServerCallContext): { tenant: string; owner: string } {
  return {
    tenant: context.tenant || DEFAULT_SCOPE,
    owner: context.user?.userName || 'anonymous',
  };
}

function getPageCursor(pageToken: string): PageCursor | null {
  if (!pageToken) return null;

  try {
    const cursor = JSON.parse(
      Buffer.from(pageToken, 'base64url').toString('utf8'),
    ) as Partial<PageCursor>;
    return typeof cursor.updatedAt === 'string' && typeof cursor.id === 'string'
      ? { updatedAt: cursor.updatedAt, id: cursor.id }
      : null;
  } catch {
    return null;
  }
}

function pageToken(document: A2ATaskDocument): string {
  return Buffer.from(JSON.stringify({
    updatedAt: document.updatedAt,
    id: document.id,
  }), 'utf8').toString('base64url');
}

function limitHistory(task: Task, historyLength?: number): Task {
  if (historyLength === undefined) return task;

  return {
    ...task,
    history: historyLength === 0 ? [] : task.history.slice(-historyLength),
  };
}

function formatTask(task: Task, params: ListTasksRequest): Task {
  const withHistory = limitHistory(task, params.historyLength);
  if (params.includeArtifacts) return withHistory;
  return { ...withHistory, artifacts: [] };
}

export class PersistentA2ATaskStore implements TaskStore {
  private readonly tasks: ICollection<A2ATaskDocument>;

  constructor(stateStore: IStateStore) {
    this.tasks = stateStore.collection<A2ATaskDocument>('a2a_tasks');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.tasks.createIndex({ fields: { tenant: 1, owner: 1, id: 1 }, unique: true }),
      this.tasks.createIndex({ fields: { tenant: 1, owner: 1, updatedAt: -1, id: -1 } }),
      this.tasks.createIndex({ fields: { tenant: 1, owner: 1, contextId: 1 } }),
      this.tasks.createIndex({ fields: { tenant: 1, owner: 1, status: 1 } }),
    ]);
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const scope = getScope(context);
    const now = new Date().toISOString();
    await this.tasks.updateOne(
      { ...scope, id: task.id },
      {
        $set: {
          contextId: task.contextId,
          status: task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
          statusTimestamp: task.status?.timestamp ?? now,
          task: structuredClone(task),
          updatedAt: now,
        },
        $setOnInsert: { ...scope, id: task.id, createdAt: now },
      },
      { upsert: true },
    );
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const document = await this.tasks.findOne({ ...getScope(context), id: taskId });
    return document ? structuredClone(document.task) : undefined;
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const scope = getScope(context);
    const pageSize = Math.min(Math.max(params.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const cursor = getPageCursor(params.pageToken);
    const baseFilter = {
      ...scope,
      ...(params.contextId ? { contextId: params.contextId } : {}),
      ...(params.status !== TaskState.TASK_STATE_UNSPECIFIED ? { status: params.status } : {}),
      ...(params.statusTimestampAfter
        ? { statusTimestamp: { $gte: params.statusTimestampAfter } }
        : {}),
    };
    const filter = cursor ? {
      ...baseFilter,
      $or: [
        { updatedAt: { $lt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, id: { $lt: cursor.id } },
      ],
    } : baseFilter;
    const [documents, totalSize] = await Promise.all([
      this.tasks.find(filter, { sort: { updatedAt: -1, id: -1 }, limit: pageSize + 1 }),
      this.tasks.countDocuments(baseFilter),
    ]);
    const hasNextPage = documents.length > pageSize;
    const page = documents.slice(0, pageSize);
    const lastDocument = page.at(-1);

    return {
      tasks: page.map((document) => formatTask(structuredClone(document.task), params)),
      nextPageToken: hasNextPage && lastDocument ? pageToken(lastDocument) : '',
      pageSize,
      totalSize,
    };
  }
}
