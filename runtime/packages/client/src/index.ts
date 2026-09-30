// Client TypeScript (MIT), généré plus tard par openapi-typescript. Squelette tâche 0.1.
export const PACKAGE_NAME = '@runtime/client';

export function createClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async health(): Promise<{ status: string }> {
      const res = await fetchImpl(`${base}/api/health`);
      if (!res.ok) throw new Error(`health: HTTP ${res.status}`);
      return (await res.json()) as { status: string };
    },
  };
}
