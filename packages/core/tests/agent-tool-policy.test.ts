import { describe, expect, it } from 'vitest';

import {
  READ_ONLY_SELF_METHODS,
  actionsForToolPolicy,
  isToolAllowedByPolicy,
} from '../src/agent/executor.js';

describe('AgentExecutor tool policy', () => {
  it('expands wildcard grants to read-only actions only', () => {
    const actions = actionsForToolPolicy(['github:*', 'slack:get_thread'], 'read_only');

    expect(actions).toContain('github:get_contents');
    expect(actions).toContain('github:list_prs');
    expect(actions).toContain('slack:get_thread');
    expect(actions).not.toContain('github:create_issue');
  });

  it('enforces read-only policy again at execution time', () => {
    expect(isToolAllowedByPolicy('github:get_contents', ['github:*'], 'read_only')).toBe(true);
    expect(isToolAllowedByPolicy('github:create_issue', ['github:*'], 'read_only')).toBe(false);
    expect(isToolAllowedByPolicy('self.read_config', [], 'read_only')).toBe(true);
    expect(isToolAllowedByPolicy('self.write_prompt', [], 'read_only')).toBe(false);
    expect(isToolAllowedByPolicy('submit_for_review', [], 'read_only')).toBe(false);
  });

  it('uses the canonical self-method set for read-only decisions', () => {
    expect(READ_ONLY_SELF_METHODS).toEqual(new Set([
      'read_config',
      'read_prompt',
      'read_source',
      'read_history',
      'read_org_chart',
      'memory_read',
      'search_memory',
    ]));
  });
});
