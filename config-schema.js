/**
 * Validates environment variables at startup.
 * Returns { errors, warnings } — callers should exit(1) on any errors.
 */
export function validateConfig(env, schema) {
  const errors = [];
  const warnings = [];

  for (const { key, required, format } of (schema.required ?? [])) {
    if (!env[key]) {
      errors.push(`Missing required env var: ${key}`);
    } else if (format === 'port') {
      const n = Number(env[key]);
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        warnings.push(`${key}="${env[key]}" is not a valid port (1–65535)`);
    }
  }

  for (const group of (schema.conditionalGroups ?? [])) {
    const set = group.keys.filter(k => env[k]);
    if (set.length > 0 && set.length < group.keys.length) {
      const missing = group.keys.filter(k => !env[k]);
      warnings.push(`Partial ${group.name} config — also set: ${missing.join(', ')}`);
    }
  }

  return { errors, warnings };
}

export const ACC_SCHEMA = {
  required: [
    { key: 'SESSION_SECRET' },
    { key: 'ADMIN_PASSWORD' },
    { key: 'PORT', format: 'port' },
  ],
  conditionalGroups: [
    { name: 'PBI', keys: ['PBI_WORKSPACE_ID', 'PBI_TENANT_ID', 'PBI_CLIENT_ID', 'PBI_CLIENT_SECRET'] },
    { name: 'APS', keys: ['APS_CLIENT_ID', 'APS_CLIENT_SECRET'] },
    { name: 'QSE', keys: ['QSE_BASE_URL', 'QSE_API_KEY'] },
  ],
};

export const IDD_SCHEMA = {
  required: [
    { key: 'SESSION_SECRET' },
    { key: 'ADMIN_PASSWORD' },
    { key: 'PORT', format: 'port' },
  ],
  conditionalGroups: [],
};
