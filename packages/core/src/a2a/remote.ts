import { randomUUID } from 'node:crypto';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role, TaskState } from '@a2a-js/sdk';

import type { Message, Part, SendMessageRequest, Task } from '@a2a-js/sdk';

const MAX_REMOTE_OUTPUT_CHARS = 100_000;

export interface RemoteAgentDefinition {
  id: string;
  url: string;
  tokenEnv?: string;
}

export interface RemoteAgentResult {
  id: string;
  output: string;
}

function parseDefinition(value: unknown, index: number): RemoteAgentDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`A2A_REMOTE_AGENTS[${index}] must be an object`);
  }

  const candidate = value as { id?: unknown; url?: unknown; tokenEnv?: unknown };
  if (typeof candidate.id !== 'string' || !/^[a-z0-9_-]+$/.test(candidate.id)) {
    throw new Error(`A2A_REMOTE_AGENTS[${index}].id must use lowercase letters, numbers, _ or -`);
  }
  if (typeof candidate.url !== 'string') {
    throw new Error(`A2A_REMOTE_AGENTS[${index}].url must be a URL`);
  }

  const url = new URL(candidate.url);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error(`Remote A2A agent ${candidate.id} must use HTTPS in production`);
  }
  if (candidate.tokenEnv !== undefined && (
    typeof candidate.tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(candidate.tokenEnv)
  )) {
    throw new Error(`A2A_REMOTE_AGENTS[${index}].tokenEnv must name an environment variable`);
  }

  return {
    id: candidate.id,
    url: url.toString().replace(/\/$/, ''),
    ...(candidate.tokenEnv ? { tokenEnv: candidate.tokenEnv } : {}),
  };
}

export function parseRemoteAgents(raw = process.env.A2A_REMOTE_AGENTS): RemoteAgentDefinition[] {
  if (!raw?.trim()) return [];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('A2A_REMOTE_AGENTS must be a JSON array');
  }

  const definitions = parsed.map(parseDefinition);
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`Duplicate remote A2A agent id: ${definition.id}`);
    }
    ids.add(definition.id);
  }
  return definitions;
}

function partToText(part: Part): string {
  if (part.content?.$case === 'text') return part.content.value;
  if (part.content?.$case === 'data') return JSON.stringify(part.content.value);
  if (part.content?.$case === 'url') return part.content.value;
  return '';
}

function messageToText(message: Message): string {
  return message.parts.map(partToText).filter(Boolean).join('\n');
}

function taskToText(task: Task): string {
  const artifacts = task.artifacts
    .flatMap((artifact) => artifact.parts)
    .map(partToText)
    .filter(Boolean);
  if (artifacts.length > 0) return artifacts.join('\n\n');

  return task.history
    .filter((message) => message.role === Role.ROLE_AGENT)
    .map(messageToText)
    .filter(Boolean)
    .join('\n\n');
}

function boundedOutput(value: string): string {
  return value.slice(0, MAX_REMOTE_OUTPUT_CHARS);
}

export class RemoteAgentRegistry {
  private readonly definitions: Map<string, RemoteAgentDefinition>;
  private readonly clients = new Map<string, Awaited<ReturnType<ClientFactory['createFromUrl']>>>();
  private readonly factory = new ClientFactory();

  constructor(definitions = parseRemoteAgents()) {
    this.definitions = new Map(definitions.map((definition) => [definition.id, definition]));
  }

  list(): RemoteAgentDefinition[] {
    return [...this.definitions.values()];
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  async run(id: string, task: string, contextId: string, signal: AbortSignal): Promise<RemoteAgentResult> {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown remote A2A agent: ${id}`);

    let client = this.clients.get(id);
    if (!client) {
      client = await this.factory.createFromUrl(definition.url);
      this.clients.set(id, client);
    }

    const request: SendMessageRequest = {
      tenant: '',
      message: {
        messageId: randomUUID(),
        contextId,
        taskId: '',
        role: Role.ROLE_USER,
        parts: [{
          content: { $case: 'text', value: task },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        }],
        metadata: { delegatedBy: 'northbridge-company-network' },
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: ['text/plain', 'application/json'],
        taskPushNotificationConfig: undefined,
        historyLength: 20,
        returnImmediately: false,
      },
      metadata: { yclaw: { source: 'northbridge-company-network' } },
    };
    const token = definition.tokenEnv ? process.env[definition.tokenEnv] : undefined;
    if (definition.tokenEnv && !token) {
      throw new Error(`Remote A2A token environment variable is missing: ${definition.tokenEnv}`);
    }

    const result = await client.sendMessage(request, {
      signal,
      ...(token ? { serviceParameters: { Authorization: `Bearer ${token}` } } : {}),
    });
    if ('status' in result) {
      const state = result.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
      if (state !== TaskState.TASK_STATE_COMPLETED) {
        throw new Error(`Remote A2A agent ${id} returned non-completed state ${TaskState[state]}`);
      }
      return {
        id,
        output: boundedOutput(
          taskToText(result) || `Remote task ${result.id} completed without text artifacts.`,
        ),
      };
    }

    return { id, output: boundedOutput(messageToText(result)) };
  }
}
