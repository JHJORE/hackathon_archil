/** Validate deployment storage before constructing any provider or starting the server. */
export function storageConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const localStorage = env.APP_STORAGE === 'file';
  const diskId = env.ARCHIL_DISK_ID?.trim() || '';
  if (!localStorage && !diskId) {
    throw new Error('ARCHIL_DISK_ID is required for Archil storage. Set it to your own disk ID, or set APP_STORAGE=file for local testing.');
  }
  const storagePrefix = (env.ARCHIL_PREFIX?.trim() || 'autonomous-sourcing/v1/').replace(/\/?$/, '/');
  return { localStorage, diskId, storagePrefix };
}
