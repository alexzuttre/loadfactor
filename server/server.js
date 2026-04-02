import { assertRuntimeConfig, getConfig } from './config.js';
import { createApp } from './app.js';
import { auditError, auditEvent } from './logging.js';

const config = getConfig();

try {
  assertRuntimeConfig(config);
} catch (error) {
  auditError('startup_configuration_invalid', error);
  process.exit(1);
}

const app = createApp(config);

app.listen(config.port, () => {
  auditEvent('service_started', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    service: config.serviceName,
    mode: config.devAuthBypass ? 'dev-bypass' : config.authMode,
  });
});
