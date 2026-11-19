// Replacement for openclaw/plugin-sdk/sqlite-runtime-testing (not published).
// These tests never open the host state database, so cleanup is a no-op.
export async function closeOpenClawStateDatabaseAsync(): Promise<void> {}
export function closeOpenClawStateDatabaseForTest(): void {}
