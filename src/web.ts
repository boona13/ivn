import { createServer } from 'node:http';
import { IvnStore } from './store.js';
import { handleDashboardApiRequest, sendJson } from './web-dashboard-api.js';
import { serveDashboardAsset } from './web-dashboard-assets.js';
import { generateAccessToken, normalizeAccessToken } from './server-security.js';

export interface DashboardHandle {
  port: number;
  url: string;
  authToken: string;
  close: () => Promise<void>;
}

export function startDashboard(
  options: { port?: number; root?: string; authToken?: string } = {},
): Promise<DashboardHandle> {
  return new Promise((resolve, reject) => {
    const port = options.port ?? 0;
    const root = options.root;
    const authToken = options.authToken
      ? normalizeAccessToken(options.authToken, 'dashboard auth token')
      : generateAccessToken();
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost`);
      const path = url.pathname;

      if (serveDashboardAsset(path, res, { dashboardToken: authToken })) {
        return;
      }

      let store: IvnStore | null = null;
      try {
        store = IvnStore.open(root);
        const handled = await handleDashboardApiRequest(req, res, url, store, authToken);
        if (!handled) {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (err: unknown) {
        sendJson(res, 500, { error: 'Internal server error.' });
      } finally {
        store?.close();
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        port: actualPort,
        url,
        authToken,
        close: () => new Promise<void>((resolveClose, rejectClose) => {
          server.close((err) => err ? rejectClose(err) : resolveClose());
        }),
      });
    });

    server.on('error', reject);
  });
}
