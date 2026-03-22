import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';

let dashboardHtmlCache: string | null = null;
let dashboardCssCache: string | null = null;
let dashboardJsCache: string | null = null;

function getDashboardHtml(): string {
  if (dashboardHtmlCache !== null) {
    return dashboardHtmlCache;
  }

  dashboardHtmlCache = readFileSync(new URL('./web-dashboard.html', import.meta.url), 'utf8');
  return dashboardHtmlCache;
}

function getDashboardCss(): string {
  if (dashboardCssCache !== null) {
    return dashboardCssCache;
  }

  dashboardCssCache = readFileSync(new URL('./web-dashboard.css', import.meta.url), 'utf8');
  return dashboardCssCache;
}

function getDashboardJs(): string {
  if (dashboardJsCache !== null) {
    return dashboardJsCache;
  }

  dashboardJsCache = readFileSync(new URL('./web-dashboard.js', import.meta.url), 'utf8');
  return dashboardJsCache;
}

export function serveDashboardAsset(
  path: string,
  res: ServerResponse,
  options: { dashboardToken?: string } = {},
): boolean {
  if (path === '/') {
    const html = getDashboardHtml().replace(
      '__IVN_DASHBOARD_TOKEN__',
      options.dashboardToken || '',
    );
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return true;
  }

  if (path === '/assets/web-dashboard.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(getDashboardCss());
    return true;
  }

  if (path === '/assets/web-dashboard.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(getDashboardJs());
    return true;
  }

  return false;
}
