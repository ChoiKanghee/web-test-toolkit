// Probe: can Chrome flags auto-approve the native getDisplayMedia (screen/tab share)
// picker, so a Tool=MCP case that needs screen capture can run unattended?
// Served over http://127.0.0.1 because getDisplayMedia needs a secure context.
//   node gdm-flag-probe.mjs [headed]     (run it in place, from a folder that has Playwright installed)
import { createServer } from 'node:http';
import { launchOptions, playwrightOrExit } from '../../../test-designer/lib/playwright.mjs';

const { chromium } = playwrightOrExit();

const HTML = `<!doctype html><title>GDM PROBE TAB</title>
<button id="b">go</button>
<script>
  window.out = null;
  document.getElementById('b').onclick = async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      window.out = { ok: true, tracks: s.getTracks().map(t => t.kind + ':' + t.label) };
      s.getTracks().forEach(t => t.stop());
    } catch (e) { window.out = { ok: false, err: e.name + ': ' + e.message }; }
  };
</script>`;

const server = createServer((_, res) => res.end(HTML)).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const CASES = [
  ['no flags (control)', []],
  ['--use-fake-ui-for-media-stream', ['--use-fake-ui-for-media-stream']],
  ['--auto-select-desktop-capture-source="Entire screen"', ['--auto-select-desktop-capture-source=Entire screen']],
  ['--auto-select-tab-capture-source-by-title="GDM PROBE TAB"', ['--auto-select-tab-capture-source-by-title=GDM PROBE TAB']],
  ['--auto-accept-this-tab-capture', ['--auto-accept-this-tab-capture']],
  ['fake-ui + auto-select-desktop', ['--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen']],
];

const headless = process.argv[2] !== 'headed';
console.log(`mode: ${headless ? 'headless' : 'headed'}  ·  ${url}`);
for (const [label, args] of CASES) {
  let browser;
  try {
    browser = await chromium.launch(launchOptions({ headless, args }));
    const page = await browser.newPage();
    await page.goto(url);
    await page.click('#b');
    const out = await page.waitForFunction('window.out', null, { timeout: 8000 })
      .then((h) => h.jsonValue())
      .catch(() => ({ ok: false, err: 'HUNG (no resolve/reject in 8s — native picker still waiting)' }));
    console.log(`${out.ok ? 'OK  ' : 'FAIL'} | ${label} | ${out.ok ? out.tracks.join(', ') : out.err}`);
  } catch (e) {
    console.log(`ERR  | ${label} | ${e.message.split('\n')[0]}`);
  } finally { await browser?.close(); }
}
server.close();
