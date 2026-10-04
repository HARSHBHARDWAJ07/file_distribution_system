// Triggers a deploy of a Render service and waits until it is live.
// Used by .github/workflows/deploy-worker.yml and runnable from a terminal:
//
//   RENDER_WORKER_SERVICE_ID=srv-xxx node scripts/render/deploy.js [commitSha]
const { render, waitForDeploy } = require('./renderApi');

async function main() {
  const serviceId = process.env.RENDER_WORKER_SERVICE_ID;
  if (!serviceId) throw new Error('RENDER_WORKER_SERVICE_ID is required');
  const commitId = process.argv[2];

  const deploy = await render('POST', `/services/${serviceId}/deploys`, {
    clearCache: 'do_not_clear',
    ...(commitId && { commitId }),
  });
  console.log(`[render] triggered deploy ${deploy.id}${commitId ? ` of ${commitId.slice(0, 7)}` : ''}`);
  await waitForDeploy(serviceId, deploy.id);
}

main().catch(err => { console.error('[render]', err.message); process.exit(1); });
