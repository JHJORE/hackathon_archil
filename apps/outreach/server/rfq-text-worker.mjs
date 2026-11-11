import { parentPort, workerData } from 'node:worker_threads';

try {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(workerData), disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, verbosity: 0 });
  const document = await task.promise;
  try {
    if (document.numPages > 100) throw new Error('PAGE_LIMIT');
    const pages = []; let chars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
      chars += text.length;
      if (chars > 400000) throw new Error('TEXT_LIMIT');
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }
    if (pages.every(page => page.text.length < 10)) throw new Error('OCR_REQUIRED');
    parentPort.postMessage({ ok: true, pages });
  } finally { await document.destroy(); }
} catch (error) {
  const codes = ['PAGE_LIMIT', 'TEXT_LIMIT', 'OCR_REQUIRED'];
  parentPort.postMessage({ ok: false, code: codes.includes(error?.message) ? error.message : error?.name === 'PasswordException' ? 'PASSWORD_REQUIRED' : 'INVALID_PDF' });
}
