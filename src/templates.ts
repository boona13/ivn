import { IvnStore } from './store.js';
import type { KnowledgeType } from './types.js';

interface TemplateEntry {
  content: string;
  type: KnowledgeType;
  tags: string[];
}

export interface InitTemplateInfo {
  id: string;
  label: string;
  description: string;
}

interface InitTemplateDefinition extends InitTemplateInfo {
  entries: TemplateEntry[];
}

const TEMPLATES: InitTemplateDefinition[] = [
  {
    id: 'nextjs',
    label: 'Next.js App',
    description: 'Seed IVN with common Next.js patterns, gotchas, and deployment reminders.',
    entries: [
      {
        type: 'pattern',
        tags: ['nextjs', 'app-router', 'react'],
        content: 'We use Next.js App Router conventions unless the project explicitly documents a Pages Router exception.',
      },
      {
        type: 'gotcha',
        tags: ['nextjs', 'server-components', 'react'],
        content: 'Watch out: server components cannot use client-only hooks unless the file is marked with "use client".',
      },
      {
        type: 'pattern',
        tags: ['nextjs', 'data-fetching'],
        content: 'Prefer server-side data fetching in route segments and server actions before adding client-side loading state complexity.',
      },
      {
        type: 'dependency',
        tags: ['nextjs', 'env'],
        content: 'Next.js only exposes environment variables to the browser when they use the NEXT_PUBLIC_ prefix.',
      },
      {
        type: 'todo',
        tags: ['nextjs', 'deployment'],
        content: 'Before launch, confirm cache invalidation and revalidation strategy for dynamic routes.',
      },
    ],
  },
  {
    id: 'express',
    label: 'Express API',
    description: 'Seed IVN with practical defaults for Express-style Node APIs.',
    entries: [
      {
        type: 'pattern',
        tags: ['express', 'api', 'node'],
        content: 'We keep Express route handlers thin and push business logic into services or modules outside the router layer.',
      },
      {
        type: 'gotcha',
        tags: ['express', 'errors'],
        content: 'Watch out: async Express handlers must forward failures to centralized error middleware instead of silently hanging requests.',
      },
      {
        type: 'pattern',
        tags: ['express', 'validation'],
        content: 'Validate request input at the boundary before it reaches downstream services or database code.',
      },
      {
        type: 'dependency',
        tags: ['express', 'proxy', 'deploy'],
        content: 'If Express runs behind a proxy or load balancer, configure trust proxy correctly before relying on client IP or secure cookies.',
      },
      {
        type: 'todo',
        tags: ['express', 'observability'],
        content: 'Before production, add structured request logging and a consistent error response contract.',
      },
    ],
  },
  {
    id: 'django',
    label: 'Django App',
    description: 'Seed IVN with common Django project conventions and sharp edges.',
    entries: [
      {
        type: 'pattern',
        tags: ['django', 'python', 'models'],
        content: 'Keep Django apps modular: views stay thin, shared logic lives in services, selectors, or model-layer helpers.',
      },
      {
        type: 'gotcha',
        tags: ['django', 'migrations', 'database'],
        content: 'Watch out: schema changes are not real until migrations are generated, reviewed, and applied in the target environment.',
      },
      {
        type: 'pattern',
        tags: ['django', 'settings'],
        content: 'Split Django settings by environment so local defaults do not leak into staging or production.',
      },
      {
        type: 'dependency',
        tags: ['django', 'static-files'],
        content: 'Static asset handling depends on collectstatic and correct storage settings before deployment is considered complete.',
      },
      {
        type: 'todo',
        tags: ['django', 'security'],
        content: 'Before release, confirm CSRF, allowed hosts, and secret management are configured for the deployment environment.',
      },
    ],
  },
];

export function listInitTemplates(): InitTemplateInfo[] {
  return TEMPLATES.map(({ id, label, description }) => ({ id, label, description }));
}

export function seedInitTemplate(store: IvnStore, templateId: string): { template: InitTemplateInfo; count: number } {
  const template = TEMPLATES.find((entry) => entry.id === templateId);
  if (!template) {
    throw new Error(
      `Unknown template "${templateId}". Available templates: ${TEMPLATES.map((entry) => entry.id).join(', ')}`,
    );
  }

  let count = 0;
  for (const entry of template.entries) {
    const { isNew } = store.rememberIfNew(entry.content, {
      type: entry.type,
      tags: entry.tags,
      source: `template:${template.id}`,
      sourceKind: 'external',
      sourceRef: `ivn-template:${template.id}`,
      reviewStatus: 'active',
      confidence: 0.9,
    });
    if (isNew) count += 1;
  }

  return {
    template: {
      id: template.id,
      label: template.label,
      description: template.description,
    },
    count,
  };
}
