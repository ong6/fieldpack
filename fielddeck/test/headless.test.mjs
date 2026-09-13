import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../agent/render.mjs';
import { validateDeck } from '../public/model.js';
test('headless renderer measures every slide and exports real PDF and PNG without notes', async () => {
  const deck = validateDeck({ version: 1, id: 'render-test', title: 'Fictional render test', slides: [{ id: 'opening', layout: 'title', title: 'A clear decision', notes: 'PRIVATE_RENDER_SENTINEL' }, { id: 'closing', layout: 'next-steps', title: 'Next action', actions: [{ text: 'Review the fictional test', owner: 'Test reviewer', date: '2027-01-01' }] }] });
  const snapshot = { deck, revision: 'test-revision' };
  const preflight = await render(snapshot, { format: 'preflight', slideNumber: 1 }); assert.equal(preflight.report.slides.length, 2); assert.ok(preflight.report.slides.every(s => s.width === 1600 && s.height === 900)); assert.ok(!JSON.stringify(preflight).includes('PRIVATE_RENDER_SENTINEL'));
  const pdf = await render(snapshot, { format: 'pdf', slideNumber: 1 }); assert.ok(Buffer.from(pdf.artifact.base64, 'base64').subarray(0, 4).equals(Buffer.from('%PDF')));
  const png = await render(snapshot, { format: 'png', slideNumber: 2 }); assert.equal(Buffer.from(png.artifact.base64, 'base64').subarray(1, 4).toString(), 'PNG');
  const crowded = validateDeck({ ...deck, slides: [{ id: 'crowded', layout: 'comparison', title: 'Crowded', columns: Array.from({ length: 3 }, () => ({ heading: 'Dense content', body: 'long content '.repeat(53) })) }] }); const crowdedReport = await render({ deck: crowded, revision: 'crowded' }, { format: 'preflight', slideNumber: 1 }); assert.ok(crowdedReport.report.issues.length > 0);
});
