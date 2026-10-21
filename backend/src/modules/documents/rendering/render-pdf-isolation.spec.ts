import { vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { renderPdf } from './render-pdf';

vi.mock('@/prisma/prisma.service', () => ({
  __esModule: true,
  default: { log: { create: vi.fn().mockResolvedValue({}) } },
}));

vi.setConfig({ testTimeout: 30_000 });

async function textOf(pdf: Buffer): Promise<string> {
  const task = getDocument({ data: new Uint8Array(pdf), isEvalSupported: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return pages.join(' ');
}

const FIRST_DOCUMENT = `<html><head><style>body::after { content: 'LEAKCSS'; }</style></head><body>
  LEAKBODY
  <script>
    window.name = 'LEAKNAME';
    window.leaked = 'LEAKGLOBAL';
    setInterval(function () { if (document.body) document.body.append('LEAKTIMER'); }, 1);
  </script>
</body></html>`;

const SECOND_DOCUMENT = `<html><body>
  SECOND
  <script>document.write(window.name + ' ' + window.leaked);</script>
</body></html>`;

// A developer machine may have no Chromium at all; CI always does, so it never skips there.
let rendererAvailable = true;
beforeAll(async () => {
  try {
    await renderPdf('<html><body>warm-up</body></html>');
  } catch (error) {
    if (process.env.CI || !String(error).includes('PDF renderer unavailable')) throw error;
    rendererAvailable = false;
  }
}, 180_000);

describe('PDF rendering on a reused page', () => {
  beforeEach((context) => {
    if (!rendererAvailable) context.skip();
  });

  it('shows nothing of the document rendered before it', async () => {
    await renderPdf(FIRST_DOCUMENT);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = await textOf(await renderPdf(SECOND_DOCUMENT));

    expect(text).toContain('SECOND');
    expect(text).not.toMatch(/LEAK/);
  });

  it('renders the same document to the same text whatever was rendered before it', async () => {
    const alone = await textOf(
      await renderPdf('<html><body><h1>Invoice 42</h1><p>Total 120.00 EUR</p></body></html>'),
    );
    await renderPdf(FIRST_DOCUMENT);

    const afterAnother = await textOf(
      await renderPdf('<html><body><h1>Invoice 42</h1><p>Total 120.00 EUR</p></body></html>'),
    );

    expect(afterAnother).toBe(alone);
  });
});
