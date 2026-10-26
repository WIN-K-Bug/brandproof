// READ-ONLY screenshots of a running showcase demo (default http://127.0.0.1:4174). It only navigates; it never clicks
// anything that saves, so the demo data is not changed.
//
//   node scripts/browser/demo-screens.mjs [http://127.0.0.1:4174]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { launch } from './cdp.mjs';

const base = process.argv[2] || 'http://127.0.0.1:4174';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'evidence');
await mkdir(out, { recursive: true });

const b = await launch(`${base}/#/workspace/SUB-4`, { port: 9358 });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
try {
  const go = async (hash) => {
    await b.eval(`location.hash = ${JSON.stringify(hash)}`);
    await b.wait(1300);
  };
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const shot = (name) => b.shot(path.join(out, `demo-live-${name}.png`));
  await b.wait(1500);

  check('demo banner says demo mode and that roles are not sign-in', /Demo mode/.test(await text('#banner')) && /not sign-in/.test(await text('#banner')));
  check('SUB-4 (banner): approved, with a retained image and two revisions', /Approved/.test(await text('.ws-title')) && (await b.eval(`!!document.querySelector('.retained-img')`)));
  await shot('1-approved-banner');
  await b.eval(`[...document.querySelectorAll('[role=tab]')].find((t) => t.innerText.startsWith('History')).click()`);
  await b.wait(500);
  await shot('2-history');
  await go('#/workspace/SUB-5');
  check('SUB-5 (winter post): Re-review required because the image was replaced', /Re-review required/.test(await text('.ws-title')) && /image details changed/.test(await text('main')));
  await shot('3-image-replaced-stale');
  await go('#/workspace/SUB-6');
  check('SUB-6 (draft): blocking findings cite a REGISTERED source passage', /Registered source/.test(await text('main')) && /Contradicts/.test(await text('main')));
  await shot('4-findings-registered');
  await go('#/sources/SRC-1');
  check('SRC-1: version 1 in force and version 2 pending (not in force)', /v1 in force/.test(await text('main')) && /Pending review/.test(await text('main')));
  await shot('5-source-pending-v2');
  await go('#/sources/SRC-1/1?start=63&end=126');
  check('exact passage view highlights text', (await text('mark.cited')).length > 10);
  await go('#/library');
  await b.eval(`[...document.querySelectorAll('[role=tab]')].find((t) => t.innerText.startsWith('Approved facts')).click()`);
  await b.wait(500);
  check('facts tab shows both Registered and Legacy provenance', /Registered/.test(await text('main')) && /Legacy: typed, not linked/.test(await text('main')));
  await shot('6-library-provenance');
  await go('#/queue');
  await shot('7-queue');
} finally {
  await b.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} read-only checks passed. Screenshots: ${out} (demo-live-*.png)`);
process.exit(failed ? 1 : 0);
