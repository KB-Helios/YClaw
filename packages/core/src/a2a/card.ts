import type { AgentCard, AgentSkill, SecurityRequirement } from '@a2a-js/sdk';

import type { AgentRouter } from '../agent/router.js';

const PROTOCOL_VERSION = '1.0';
const DEFAULT_PROVIDER_URL = 'https://github.com/KB-Helios/YClaw';

function getBaseUrl(): string {
  const configured = process.env.A2A_PUBLIC_URL?.trim().replace(/\/$/, '');
  if (configured) {
    const url = new URL(configured);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error('A2A_PUBLIC_URL must use HTTPS in production');
    }
    return url.toString().replace(/\/$/, '');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('A2A_PUBLIC_URL is required when A2A is enabled in production');
  }
  return `http://localhost:${process.env.PORT || '3000'}`;
}

function securityRequirements(): SecurityRequirement[] {
  return [{ schemes: { bearerAuth: { list: [] } } }];
}

function buildAgentSkills(router: AgentRouter): AgentSkill[] {
  return [...router.getAllConfigs().values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((config) => ({
      id: `yclaw.agent.${config.name}`,
      name: config.name,
      description: `${config.description} Department: ${config.department}.`,
      tags: ['yclaw', config.department, config.name, 'agent-delegation'],
      examples: [`Delegate a ${config.department} task to ${config.name}.`],
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['text/plain', 'application/json'],
      securityRequirements: securityRequirements(),
    }));
}

export function buildAgentCard(router: AgentRouter): AgentCard {
  const baseUrl = getBaseUrl();
  const collaborationSkill: AgentSkill = {
    id: 'yclaw.collaborative-solve',
    name: 'Collaborative problem solving',
    description: 'Fan out one problem to multiple local or remote A2A agents and synthesize their evidence into one governed result.',
    tags: ['multi-agent', 'orchestration', 'a2a', 'company-automation'],
    examples: [
      'Ask Strategy, Development, and Operations to assess a launch plan and synthesize one recommendation.',
    ],
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain', 'application/json'],
    securityRequirements: securityRequirements(),
  };

  return {
    name: 'NorthBridge Company Agent Network',
    description: 'Governed YClaw organization for NorthBridge company automation and cross-framework A2A collaboration.',
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a/v1`,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: PROTOCOL_VERSION,
      },
      {
        url: `${baseUrl}/a2a/rest`,
        protocolBinding: 'HTTP+JSON',
        tenant: '',
        protocolVersion: PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: 'KB-Helios',
      url: process.env.A2A_PROVIDER_URL || DEFAULT_PROVIDER_URL,
    },
    version: process.env.YCLAW_VERSION || '0.1.0',
    documentationUrl: process.env.A2A_DOCUMENTATION_URL
      || `${DEFAULT_PROVIDER_URL}/blob/main/docs/a2a-backbone.md`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [],
    },
    securitySchemes: {
      bearerAuth: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: 'YClaw operator API key',
            scheme: 'Bearer',
            bearerFormat: 'gzop_live_*',
          },
        },
      },
    },
    securityRequirements: securityRequirements(),
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [collaborationSkill, ...buildAgentSkills(router)],
    signatures: [],
  };
}
