import fs from 'node:fs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const { createApp, appOrigin } = await import('./app.js');
const { closeDatabases } = await import('./db.js');
const { initializeDiscovery, startWorkspaceWorker } = await import('./workspaces.js');
const { startScheduler, stopScheduler } = await import('./scheduler.js');

const port = Number(process.env.PORT) || 4300;
const hosted = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.PUBLIC_MODE === '1' || process.env.NODE_ENV === 'production');
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const configuredOrigin = process.env.APP_ORIGIN || (railwayDomain ? `https://${railwayDomain}` : undefined);
const origin = appOrigin(configuredOrigin, port, hosted);
const app = createApp({
  origin,
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
});
const hosts = process.env.HOST ? [process.env.HOST] : hosted ? ['::', '0.0.0.0'] : ['127.0.0.1', '::1'];
const servers = [];

initializeDiscovery();
for (const host of hosts) {
  try {
    const server = await new Promise((resolve, reject) => {
      const listener = app.listen(port, host);
      listener.once('listening', () => resolve(listener));
      listener.once('error', reject);
    });
    servers.push(server);
    if (hosted && !process.env.HOST) break;
  } catch (error) {
    if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error;
  }
}
if (!servers.length) throw new Error(`Could not bind port ${port}`);
console.log(`JobIntel listening on ${origin}`);
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.warn('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable sign-in.');
}

startScheduler();
const stopWorkspaceWorker = startWorkspaceWorker();
function shutdown() {
  stopScheduler();
  stopWorkspaceWorker();
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
  closeDatabases();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
