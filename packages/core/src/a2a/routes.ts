import { InMemoryTaskStore, DefaultRequestHandler, UnauthenticatedUser } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express';

import type { Express, Request } from 'express';
import type { A2ARequestHandler, TaskStore, User } from '@a2a-js/sdk/server';
import type { AgentContext } from '../bootstrap/agents.js';
import type { ServiceContext } from '../bootstrap/services.js';
import type { OperatorRequest } from '../operators/types.js';
import { createLogger } from '../logging/logger.js';
import { A2AOperatorUser } from './auth.js';
import { buildAgentCard } from './card.js';
import { YClawA2AExecutor } from './executor.js';
import { RemoteAgentRegistry } from './remote.js';
import { PersistentA2ATaskStore } from './task-store.js';

const logger = createLogger('a2a');

export interface A2ABridge {
  requestHandler: A2ARequestHandler;
  mountAgentCard(app: Express): void;
  mountTransports(app: Express): void;
}

async function createTaskStore(services: ServiceContext): Promise<TaskStore> {
  const stateStore = services.infrastructure?.stateStore;
  if (stateStore && await stateStore.healthy()) {
    const taskStore = new PersistentA2ATaskStore(stateStore);
    await taskStore.initialize();
    logger.info('A2A task persistence initialized');
    return taskStore;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('A2A requires a healthy state store in production');
  }
  logger.warn('A2A state store unavailable; using process-local task storage in development');
  return new InMemoryTaskStore();
}

async function buildUser(req: Request): Promise<User> {
  const operator = (req as OperatorRequest).operator;
  return operator ? new A2AOperatorUser(operator) : new UnauthenticatedUser();
}

export async function createA2ABridge(
  services: ServiceContext,
  agents: AgentContext,
): Promise<A2ABridge | null> {
  if (process.env.A2A_ENABLED === 'false') {
    logger.info('A2A backbone disabled by A2A_ENABLED=false');
    return null;
  }

  const taskStore = await createTaskStore(services);
  const remotes = new RemoteAgentRegistry();
  const executor = new YClawA2AExecutor(agents, remotes);
  const requestHandler = new DefaultRequestHandler(
    buildAgentCard(agents.router),
    taskStore,
    executor,
  );

  return {
    requestHandler,
    mountAgentCard(app): void {
      app.use(
        '/.well-known/agent-card.json',
        agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 60 } }),
      );
      logger.info('A2A Agent Card registered', { path: '/.well-known/agent-card.json' });
    },
    mountTransports(app): void {
      app.use('/a2a/v1', jsonRpcHandler({ requestHandler, userBuilder: buildUser }));
      app.use('/a2a/rest', restHandler({ requestHandler, userBuilder: buildUser }));
      logger.info('A2A transports registered', {
        jsonRpc: '/a2a/v1',
        rest: '/a2a/rest',
        remotes: remotes.list().map((remote) => remote.id),
      });
    },
  };
}
