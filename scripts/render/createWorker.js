// One-time: creates the worker on Render as a free Docker Web Service.
// Copies DATABASE_URL and STORAGE_* from the existing file-service so no
// secret is ever typed or committed. Safe to re-run: exits if it exists.
//
//   node scripts/render/createWorker.js
//
// Env overrides: WORKER_NAME, FILE_SERVICE_URL
const { render, listAll, waitForDeploy } = require('./renderApi');

const WORKER_NAME = process.env.WORKER_NAME || 'file-distribution-worker';
const FILE_SERVICE_URL = process.env.FILE_SERVICE_URL || 'https://file-distribution-file-service.onrender.com';
const REPO = 'https://github.com/HARSHBHARDWAJ07/file_distribution_system';
const COPIED_ENV = /^(DATABASE_URL|STORAGE_.+)$/;

async function main() {
  const services = await listAll('/services', 'service');
  const existing = services.find(s => s.name === WORKER_NAME);
  if (existing) {
    console.log(`[render] ${WORKER_NAME} already exists: ${existing.id} ${existing.serviceDetails?.url || ''}`);
    return;
  }

  const fileService = services.find(s => s.serviceDetails?.url === FILE_SERVICE_URL);
  if (!fileService) throw new Error(`no service with url ${FILE_SERVICE_URL}; set FILE_SERVICE_URL`);
  console.log(`[render] copying env from ${fileService.name} (${fileService.id})`);

  const envVars = (await listAll(`/services/${fileService.id}/env-vars`, 'envVar'))
    .filter(e => COPIED_ENV.test(e.key))
    .map(({ key, value }) => ({ key, value }));
  const missing = ['DATABASE_URL', 'STORAGE_BUCKET', 'STORAGE_ENDPOINT'].filter(k => !envVars.some(e => e.key === k));
  if (missing.length) throw new Error(`file-service is missing env vars: ${missing.join(', ')}`);

  const { service, deployId } = await render('POST', '/services', {
    type: 'web_service',
    name: WORKER_NAME,
    ownerId: fileService.ownerId,
    repo: REPO,
    branch: 'main',
    autoDeploy: 'no', // deploys come from .github/workflows/deploy-worker.yml after tests pass
    envVars,
    serviceDetails: {
      runtime: 'docker',
      plan: 'free',
      region: fileService.serviceDetails.region,
      healthCheckPath: '/health',
      envSpecificDetails: { dockerfilePath: './apps/worker/Dockerfile', dockerContext: '.' },
    },
  });
  console.log(`[render] created ${service.name}: ${service.id} ${service.serviceDetails?.url || ''}`);
  console.log(`[render] copied env: ${envVars.map(e => e.key).join(', ')}`);

  if (deployId) await waitForDeploy(service.id, deployId);
  console.log(`\nRENDER_WORKER_SERVICE_ID=${service.id}`);
  console.log(`WORKER_HEALTH_URL=${service.serviceDetails?.url}/health`);
}

main().catch(err => { console.error('[render]', err.message); process.exit(1); });
