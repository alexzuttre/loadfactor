import { assertRuntimeConfig, getConfig } from './config.js';
import { createApp } from './app.js';
import { auditError, auditEvent } from './logging.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = getConfig();

try {
  assertRuntimeConfig(config);
} catch (error) {
  auditError('startup_configuration_invalid', error);
  process.exit(1);
}

const app = createApp(config);

const legacyNodeModulesPath = path.join(__dirname, 'node_modules');
if (fs.existsSync(legacyNodeModulesPath)) {
  auditEvent('legacy_server_node_modules_detected', {
    path: legacyNodeModulesPath,
  });
}

const server = app.listen(config.port, () => {
  auditEvent('service_started', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    service: config.serviceName,
    mode: config.devAuthBypass ? 'dev-bypass' : config.authMode,
  });
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  auditEvent('service_stopping', {
    signal,
    service: config.serviceName,
  });

  const forceTimer = setTimeout(() => {
    auditError('service_stop_forced', new Error(`Forced shutdown after ${signal}`), {
      signal,
      service: config.serviceName,
    });
    process.exit(1);
  }, 1500);
  forceTimer.unref();

  server.close(() => {
    clearTimeout(forceTimer);
    auditEvent('service_stopped', {
      signal,
      service: config.serviceName,
    });
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
