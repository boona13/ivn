const response = await fetch('http://127.0.0.1:3103/v1/webhooks/knowledge', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    content: 'Watch out: payment retries must stay idempotent across webhook replays.',
    type: 'gotcha',
    tags: ['payments', 'webhook'],
    source: 'reference-example',
    source_kind: 'external',
  }),
});

if (!response.ok) {
  const error = await response.text();
  throw new Error(`IVN HTTP ingest failed: ${response.status} ${error}`);
}

const body = await response.json();
console.log(JSON.stringify(body, null, 2));
