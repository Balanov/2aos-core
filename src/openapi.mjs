export function openApi(baseUrl) {
  const paths = {};
  const add = (path, method, summary, auth = true) => {
    paths[path] ||= {};
    paths[path][method] = { summary, ...(auth ? { security: [{ bearerAuth: [] }] } : {}), responses: { '200': { description: 'Success' }, '400': { description: 'Request error' }, '401': { description: 'Unauthorized' }, '422': { description: 'Validation error' } } };
  };
  add('/health/live', 'get', 'Liveness', false); add('/health/ready', 'get', 'Readiness and local model state', false);
  add('/v1/catalog', 'get', 'Full 2AOS catalog'); add('/v1/packages', 'get', 'Wholesale packages');
  add('/v1/director/analyze', 'post', 'Evidence-linked business analysis');
  add('/v1/objects', 'post', 'Upsert versioned business object with provenance');
  add('/v1/installations/quote', 'post', 'Create exact agent installation quote');
  add('/v1/packages/quote', 'post', 'Create exact package installation quote');
  add('/v1/installations', 'get', 'List installations');
  add('/v1/jobs', 'post', 'Enqueue idempotent agent job'); add('/v1/jobs/{id}', 'get', 'Get job state and result');
  add('/v1/pools', 'post', 'Create agent pool'); add('/v1/pools/{id}/messages', 'post', 'Send shared goal to agent pool');
  add('/v1/conversations/{id}/messages', 'get', 'Read group conversation');
  add('/v1/approvals', 'get', 'List approvals'); add('/v1/approvals/{id}/approve', 'post', 'Approve exact digest and commit'); add('/v1/approvals/{id}/reject', 'post', 'Reject approval');
  add('/v1/integrations', 'post', 'Store encrypted integration config'); add('/v1/integrations/{id}/test', 'post', 'Non-mutating integration check');
  add('/v1/packages/upload', 'post', 'Upload signed declarative agent ZIP'); add('/v1/packages/import', 'post', 'Import agent ZIP from allowlisted URL');
  add('/v1/agent-versions/{id}/moderate', 'post', 'Activate or reject submitted agent');
  add('/v1/developer/dashboard', 'get', 'Real installations, revenue and conversion');
  add('/v1/partners', 'post', 'Create referral partner'); add('/v1/partners/{id}/dashboard', 'get', 'Partner referrals and commission');
  add('/v1/privacy/consent', 'post', 'Opt in or out of aggregate signals'); add('/v1/privacy/signals', 'post', 'Create allowlisted local signal'); add('/v1/market/export', 'post', 'Build k-threshold market aggregate'); add('/v1/market/overview', 'get', 'Read anonymized market aggregates');
  add('/v1/knowledge/documents', 'post', 'Ingest local knowledge document'); add('/v1/knowledge/query', 'post', 'Grounded local knowledge query');
  add('/v1/schedules', 'post', 'Schedule recurring local agent job'); add('/v1/stop', 'post', 'Epoch-fenced emergency stop');
  add('/v1/audit/verify', 'get', 'Verify tenant audit hash chain');
  return { openapi: '3.1.0', info: { title: '2AOS Core API', version: '0.1.0', description: 'Local-first agent director, orchestration, marketplace, billing and privacy gateway. See docs/API.md for payload examples.' }, servers: [{ url: baseUrl }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API key' } } }, paths };
}
