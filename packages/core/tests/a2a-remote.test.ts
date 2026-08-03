import { afterEach, describe, expect, it } from 'vitest';

import { parseRemoteAgents } from '../src/a2a/remote.js';

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
});
