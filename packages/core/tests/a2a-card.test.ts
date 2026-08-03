import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRouter } from '../src/agent/router.js';
import type { AgentConfig } from '../src/config/schema.js';
import { buildAgentCard } from '../src/a2a/card.js';

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

describe('A2A Agent Card', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('publishes v1 transports, Bearer security, and sorted local-agent skills', () => {
    process.env.NODE_ENV = 'test';
    process.env.A2A_PUBLIC_URL = 'https://agents.northbridge.test/';
    const configs = new Map([
      ['sentinel', config('sentinel', 'operations')],
      ['architect', config('architect', 'development')],
    ]);
    const router = { getAllConfigs: () => configs } as unknown as AgentRouter;

    const card = buildAgentCard(router);

    expect(card.supportedInterfaces).toEqual([
      expect.objectContaining({
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        url: 'https://agents.northbridge.test/a2a/v1',
      }),
      expect.objectContaining({
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
        url: 'https://agents.northbridge.test/a2a/rest',
      }),
    ]);
    expect(card.securitySchemes.bearerAuth).toBeDefined();
    expect(card.skills.map((skill) => skill.id)).toEqual([
      'yclaw.collaborative-solve',
      'yclaw.agent.architect',
      'yclaw.agent.sentinel',
    ]);
  });

  it('fails closed on a non-HTTPS production origin', () => {
    process.env.NODE_ENV = 'production';
    process.env.A2A_PUBLIC_URL = 'http://agents.northbridge.test';
    const router = { getAllConfigs: () => new Map() } as unknown as AgentRouter;

    expect(() => buildAgentCard(router)).toThrow('must use HTTPS');
  });
});
