import { require } from './util.mjs';

export const DEVELOPER_COMMANDS = [
  { command: 'opportunities.list', method: 'GET', path: '/v1/developer/opportunities', role: 'developer', description: 'List privacy-preserving business opportunities', input: { niche: 'optional taxonomy code' } },
  { command: 'opportunities.brief', method: 'GET', path: '/v1/developer/briefs/{niche}', role: 'developer', description: 'Get machine-readable requirements, schemas and acceptance criteria', input: { niche: 'required taxonomy code' } },
  { command: 'agent.scaffold', method: 'LOCAL', path: '2aos-developer scaffold <niche> --dir <directory>', role: 'local', description: 'Generate valid declarative manifest for customization' },
  { command: 'agent.validate', method: 'LOCAL', path: '2aos-developer validate <package.zip>', role: 'local', description: 'Validate ZIP, manifest, signature policy and runtime' },
  { command: 'agent.submit', method: 'POST', path: '/v1/packages/upload', role: 'developer', description: 'Submit ZIP for moderation', input: { zipBase64: 'base64 ZIP' } },
  { command: 'agent.status', method: 'GET', path: '/v1/agent-versions', role: 'developer', description: 'Read own draft/moderation/active/rejected versions' },
  { command: 'agent.moderate', method: 'POST', path: '/v1/agent-versions/{id}/moderate', role: 'admin', description: 'Activate, reject or disable a submitted version' },
  { command: 'installation.quote', method: 'POST', path: '/v1/installations/quote', role: 'operator', description: 'Create exact installation offer for a business' },
  { command: 'approval.approve', method: 'POST', path: '/v1/approvals/{id}/approve', role: 'operator', description: 'Approve exact digest and commit installation/action' },
  { command: 'job.enqueue', method: 'POST', path: '/v1/jobs', role: 'operator', description: 'Execute an installed agent with idempotency key' },
  { command: 'job.status', method: 'GET', path: '/v1/jobs/{id}', role: 'viewer', description: 'Read queued/leased/succeeded/dead_letter/cancelled state and result' },
  { command: 'developer.dashboard', method: 'GET', path: '/v1/developer/dashboard', role: 'developer', description: 'Read actual installations, paid revenue and conversion' }
];

export class DeveloperExchange {
  constructor(store) { this.store = store; }

  opportunities(niche) {
    const rows = this.store.all('SELECT * FROM market_exports ORDER BY created_at DESC');
    const seen = new Set(), result = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      if (niche && payload.niche !== niche) continue;
      if (seen.has(payload.niche)) continue;
      seen.add(payload.niche);
      result.push({
        niche: payload.niche, companyCount: payload.companyCount, observationCount: payload.observationCount,
        urgencyMedianRounded: payload.urgencyMedianRounded, complexityMedianRounded: payload.complexityMedianRounded,
        agentCountMedianRounded: payload.agentCountMedianRounded,
        monthlyCostMinorMedianRounded: payload.monthlyCostMinorMedianRounded,
        briefUrl: `/v1/developer/briefs/${payload.niche}`,
        privacy: payload.privacy, updatedAt: row.created_at
      });
    }
    return result;
  }

  brief(niche) {
    const opportunity = this.opportunities(niche)[0];
    require(opportunity, 404, 'opportunity_not_found', 'No privacy-approved aggregate exists for this niche');
    return {
      briefId: `brief_${opportunity.niche}_${opportunity.updatedAt}`,
      schemaVersion: '2aos.developer-brief/v1', niche,
      demand: opportunity,
      task: {
        objective: `Build an agent for observed process ${niche}; use supplied evidence and do not invent business results.`,
        suggestedSlug: `${niche}-solution`,
        inputSchema: observationSchema(),
        outputSchema: resultSchema(),
        runtimeOptions: ['declarative', 'external_sandboxed_worker'],
        requiredPermissions: [],
        acceptance: [
          'Manifest passes 2aos.agent/v1 validation and safe ZIP verification',
          'Output validates the declared JSON Schema',
          'Observations and recommendations retain evidence.source and observedAt',
          'Consequential effects require approval or an explicit autonomous policy',
          'No raw tenant content, identifiers or unverified performance claims',
          'Idempotent retry does not duplicate effects or usage'
        ]
      },
      flow: ['agent.scaffold', 'agent.validate', 'agent.submit', 'agent.moderate', 'installation.quote', 'approval.approve', 'job.enqueue', 'developer.dashboard'],
      commands: DEVELOPER_COMMANDS
    };
  }

  scaffold(niche) {
    require(/^[a-z][a-z0-9-]{1,60}$/.test(niche), 422, 'validation_error', 'Invalid niche');
    return {
      schemaVersion: '2aos.agent/v1', slug: `${niche}-solution`, version: '1.0.0',
      name: `${niche} evidence processor`, description: 'Declarative starter: preserves supplied observation without inventing results',
      permissions: [], inputSchema: observationSchema(), outputSchema: resultSchema(),
      runtime: {
        kind: 'declarative',
        steps: [{ id: 'format', type: 'template', value: { status: 'draft', findings: '{{input.observation}}' } }],
        output: { status: '{{steps.format.output.status}}', findings: '{{steps.format.output.findings}}' }
      },
      pricing: { currency: 'RUB', monthlyMinor: 100000 }, developerBps: 7000
    };
  }

  card(baseUrl) {
    return {
      schemaVersion: '2aos.capabilities/v1', name: '2AOS Developer Exchange', baseUrl,
      authentication: { type: 'bearer', header: 'Authorization', format: 'Bearer API_KEY' },
      flow: this.briefFlow(),
      commands: DEVELOPER_COMMANDS,
      links: { opportunities: '/v1/developer/opportunities', openapi: '/openapi.json', llms: '/llms.txt', repository: 'https://github.com/Balanov/2aos-core' }
    };
  }

  briefFlow() {
    return ['GET /v1/developer/opportunities', 'GET /v1/developer/briefs/{niche}', 'LOCAL 2aos-developer scaffold', 'LOCAL 2aos-developer validate', 'POST /v1/packages/upload', 'POST /v1/agent-versions/{id}/moderate', 'POST /v1/installations/quote', 'POST /v1/approvals/{id}/approve', 'POST /v1/jobs', 'GET /v1/developer/dashboard'];
  }

  llmsText(baseUrl) {
    return `# 2AOS Developer Exchange\n\nUse machine-readable opportunities only. Never request or export raw tenant data.\n\nCapabilities: ${baseUrl}/.well-known/2aos.json\nOpenAPI: ${baseUrl}/openapi.json\n\nRecommended flow:\n${this.briefFlow().map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\nUse an exact approval digest before every installation or consequential action. Treat provider receipts as assertions, not independent physical proof. Revenue is calculated only from actual paid invoices and ledger entries.\n`;
  }
}

function observationSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['observation'],
    properties: {
      observation: {
        type: 'object', additionalProperties: false, required: ['processCode', 'evidence'],
        properties: {
          processCode: { type: 'string', minLength: 2, maxLength: 80 },
          description: { type: 'string', maxLength: 10000 },
          metrics: { type: 'object' },
          evidence: {
            type: 'object', additionalProperties: false, required: ['source', 'observedAt'],
            properties: { source: { type: 'string', minLength: 1, maxLength: 500 }, observedAt: { type: 'string', minLength: 8, maxLength: 40 } }
          }
        }
      }
    }
  };
}
function resultSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['status', 'findings'],
    properties: {
      status: { enum: ['draft', 'needs_review', 'ready'] },
      findings: { description: 'Evidence-linked findings in the agent-defined structure' }
    }
  };
}
