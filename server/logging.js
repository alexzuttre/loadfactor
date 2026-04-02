function serialize(payload) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

export function auditEvent(event, fields = {}) {
  console.log(serialize({ severity: 'INFO', event, ...fields }));
}

export function auditError(event, error, fields = {}) {
  console.error(serialize({
    severity: 'ERROR',
    event,
    message: error?.message || String(error),
    ...fields,
  }));
}
