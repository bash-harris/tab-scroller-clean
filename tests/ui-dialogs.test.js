// tests/ui-dialogs.test.js
// Puppeteer gate for the two user-visible dialog features in content.js:
//
//   1. OPEN_TABS_PICKER — when background matches N tabs for an open command,
//      the content script shows EVERY option (favicon / title / host) in a
//      centered ivory modal; picking a row calls back with that tab's id.
//   2. Persistent ivory error dialog — errors get a centered modal with a gold
//      accent and a single Cancel button, and NO auto-dismiss timer (it must
//      still be on screen after 5s).
//
// The builders live at the bottom of content.js between the UIDIALOGS markers
// as pure DOM factories (UIDialogs.buildPickerModal / buildErrorDialog). This
// test extracts that block, evaluates it inside a real browser page whose
// :root carries the content.css theme tokens, and drives the DOM directly.
//
//   node tests/ui-dialogs.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const puppeteer = require('puppeteer');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`); }
}

// --- extract the UIDialogs builder source from content.js -------------------
const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const BEGIN = '// ===== UI DIALOG BUILDERS — BEGIN UIDIALOGS =====';
const END = '// ===== UI DIALOG BUILDERS — END UIDIALOGS =====';
const b = contentSrc.indexOf(BEGIN);
const e = contentSrc.indexOf(END);
assert(b !== -1 && e !== -1 && e > b, 'UIDIALOGS markers found in content.js');
const builderSrc = contentSrc.slice(b, e);

// Node-side sanity: the extracted block defines the exported namespace shape.
{
  const fakeModule = { exports: {} };
  const fn = new Function('module', 'exports', 'document', 'window',
    `${builderSrc}\nreturn UIDialogs;`);
  const ns = fn(fakeModule, fakeModule.exports, undefined, undefined);
  ok('node eval: UIDialogs.buildPickerModal is a function', typeof ns.buildPickerModal === 'function');
  ok('node eval: UIDialogs.buildErrorDialog is a function', typeof ns.buildErrorDialog === 'function');
  ok('node eval: module.exports receives the namespace',
    typeof fakeModule.exports.buildPickerModal === 'function' &&
    typeof fakeModule.exports.buildErrorDialog === 'function');
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    await page.goto('about:blank');

    // Mirror the light-theme tokens from content.css on :root so the inline
    // var(--ts-*, fallback) styles resolve to Tab Scroller's ivory palette.
    await page.addStyleTag({
      content: `
        :root {
          --ts-bg-solid: #fcf8f0;
          --ts-bg-raise: #fdfaf2;
          --ts-accent: #9c7817;
          --ts-accent-dim: #7d5f10;
          --ts-accent-glow: rgba(156, 120, 23, 0.30);
          --ts-text: #1b160e;
          --ts-text-muted: #6b6150;
          --ts-hairline: rgba(33, 28, 20, 0.09);
          --ts-fill: rgba(33, 28, 20, 0.04);
        }
      `,
    });

    // Evaluate the extracted builders in the page; expose them on window.
    await page.evaluate((src) => {
      const fn = new Function(`${src}\nreturn UIDialogs;`);
      window.UIDialogs = fn();
      window.__picked = null;
      window.__cancelled = false;
      window.__resetHooks = () => {
        window.__picked = null;
        window.__cancelled = false;
        return true;
      };
    }, builderSrc);

    // ---- FEATURE 1: picker renders every option ---------------------------
    console.log('\n--- open-tabs picker ---');
    {
      const state = await page.evaluate(() => {
        window.__resetHooks();
        const options = [
          { id: 11, title: 'Gmail - Inbox', url: 'https://mail.google.com/u/0/#inbox', favIconUrl: '' },
          { id: 22, title: 'Pull request #42 \u00b7 repo', url: 'https://github.com/acme/repo/pull/42', favIconUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
          { id: 33, title: 'Very long title that should ellipsize rather than wrap across rows nicely', url: 'not a url at all', favIconUrl: '' },
        ];
        const root = window.UIDialogs.buildPickerModal(options, {
          onPick: (tabId) => { window.__picked = tabId; },
          onCancel: () => { window.__cancelled = true; },
        });
        document.body.appendChild(root);
        const rows = [...root.querySelectorAll('.ts-picker-row')];
        return {
          attached: document.body.contains(root),
          header: root.querySelector('.ts-picker-title').textContent,
          rowCount: rows.length,
          titles: rows.map((r) => r.querySelector('.ts-picker-row-title').textContent),
          hosts: rows.map((r) => r.querySelector('.ts-picker-row-host').textContent),
          rowIds: rows.map((r) => r.dataset.tabId),
          hasFaviconImg: !!root.querySelector('img.ts-picker-favicon'),
          hasGlyphFallback: root.textContent.includes('\u2750'),
          listMaxHeightVh: root.querySelector('.ts-picker-list').style.maxHeight,
        };
      });
      ok('modal attaches to document', state.attached);
      ok(`header says "3 matching tabs — pick one to open"`,
        state.header === '3 matching tabs \u2014 pick one to open', state.header);
      ok('renders a row for EVERY option (3 rows)', state.rowCount === 3, state.rowCount);
      ok('titles rendered per option', state.titles[0] === 'Gmail - Inbox' &&
        state.titles[1] === 'Pull request #42 \u00b7 repo' && state.titles[2].startsWith('Very long title'), state.titles);
      ok('hosts derived from url', state.hosts[0] === 'mail.google.com' && state.hosts[1] === 'github.com', state.hosts);
      ok('rows carry their tab ids (dataset)', state.rowIds.join(',') === '11,22,33', state.rowIds);
      ok('favicon img present for option with favIconUrl', state.hasFaviconImg);
      ok('generic tab glyph used as favicon fallback', state.hasGlyphFallback);
      ok('list scrolls (max-height 60vh)', state.listMaxHeightVh === '60vh', state.listMaxHeightVh);

      // row click -> onPick with the right tab id -> modal closes itself
      const pickedState = await page.evaluate(() => {
        const root = document.querySelector('.ts-picker-modal');
        root.querySelectorAll('.ts-picker-row')[1].click();
        return {
          picked: window.__picked,
          removed: !document.body.contains(root),
        };
      });
      ok('row click calls onPick with right tab id (22)', pickedState.picked === 22, pickedState.picked);
      ok('row click closes the modal', pickedState.removed === true);

      // Cancel button closes without acting
      const cancelState = await page.evaluate(() => {
        window.__resetHooks();
        const options = [{ id: 5, title: 'T', url: 'https://x.example/a', favIconUrl: '' }];
        const root = window.UIDialogs.buildPickerModal(options, {
          onPick: (tabId) => { window.__picked = tabId; },
          onCancel: () => { window.__cancelled = true; },
        });
        document.body.appendChild(root);
        [...root.querySelectorAll('button')].find((btn) => btn.textContent === 'Cancel').click();
        return {
          picked: window.__picked,
          cancelled: window.__cancelled,
          removed: !document.body.contains(root),
        };
      });
      ok('Cancel click fires onCancel, no pick', cancelState.cancelled === true && cancelState.picked === null);
      ok('Cancel click removes the modal', cancelState.removed === true);

      // Esc key closes without acting
      const escState = await page.evaluate(() => {
        window.__resetHooks();
        const options = [
          { id: 1, title: 'a', url: 'https://a.example/', favIconUrl: '' },
          { id: 2, title: 'b', url: 'https://b.example/', favIconUrl: '' },
        ];
        const root = window.UIDialogs.buildPickerModal(options, {
          onCancel: () => { window.__cancelled = true; },
        });
        document.body.appendChild(root);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return {
          cancelled: window.__cancelled,
          removed: !document.body.contains(root),
        };
      });
      ok('Esc key removes the picker', escState.removed === true);
      ok('Esc key counts as cancel', escState.cancelled === true);

      // >8 options: the list actually scrolls instead of growing forever
      const scrollState = await page.evaluate(() => {
        const options = [];
        for (let i = 0; i < 12; i++) {
          options.push({ id: i, title: `Tab ${i}`, url: `https://host${i}.example/x`, favIconUrl: '' });
        }
        const root = window.UIDialogs.buildPickerModal(options, {});
        document.body.appendChild(root);
        const list = root.querySelector('.ts-picker-list');
        const out = {
          rowCount: root.querySelectorAll('.ts-picker-row').length,
          scrollable: list.scrollHeight > list.clientHeight,
        };
        root.remove();
        return out;
      });
      ok('12 options render 12 rows', scrollState.rowCount === 12, scrollState.rowCount);
      ok('12-option list scrolls within max-height', scrollState.scrollable === true, scrollState);
    }

    // ---- FEATURE 2: persistent ivory error dialog -------------------------
    console.log('\n--- persistent ivory error dialog ---');
    {
      const state = await page.evaluate(() => {
        window.__resetHooks();
        const root = window.UIDialogs.buildErrorDialog('Could not reach the tab service.', {
          onCancel: () => { window.__cancelled = true; },
        });
        document.body.appendChild(root);
        const buttons = [...root.querySelectorAll('button')];
        return {
          attached: document.body.contains(root),
          header: root.querySelector('.ts-error-dialog-title').textContent,
          body: root.querySelector('.ts-error-dialog-message').textContent,
          buttonLabels: buttons.map((btn) => btn.textContent),
          panelBg: getComputedStyle(root.querySelector(':scope > div:last-child')).backgroundColor ||
            getComputedStyle([...root.children].at(-1)).backgroundColor,
        };
      });
      ok('error dialog attaches', state.attached);
      ok('header is "Something went wrong"', state.header === 'Something went wrong', state.header);
      ok('message body carries the error text',
        state.body === 'Could not reach the tab service.', state.body);
      ok('exactly one button and it is Cancel',
        state.buttonLabels.length === 1 && state.buttonLabels[0] === 'Cancel', state.buttonLabels);

      // NO auto-dismiss timer: still present after 5.2s
      await new Promise((resolve) => setTimeout(resolve, 5200));
      const persistState = await page.evaluate(() => ({
        stillThere: !!document.querySelector('.ts-error-dialog'),
      }));
      ok('still present after 5.2s (no auto-hide timer)', persistState.stillThere === true);

      const cancelState = await page.evaluate(() => {
        const root = document.querySelector('.ts-error-dialog');
        [...root.querySelectorAll('button')].find((btn) => btn.textContent === 'Cancel').click();
        return {
          cancelled: window.__cancelled,
          removed: !document.body.contains(root),
        };
      });
      ok('Cancel click fires onCancel', cancelState.cancelled === true);
      ok('Cancel click removes the error dialog', cancelState.removed === true);

      const escState = await page.evaluate(() => {
        window.__resetHooks();
        const root = window.UIDialogs.buildErrorDialog('second error', {
          onCancel: () => { window.__cancelled = true; },
        });
        document.body.appendChild(root);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { cancelled: window.__cancelled, removed: !document.body.contains(root) };
      });
      ok('Esc key removes the error dialog', escState.removed === true && escState.cancelled === true);

      // ivory + gold theme tokens actually resolve through the inline styles
      const themeState = await page.evaluate(() => {
        const root = window.UIDialogs.buildErrorDialog('theme check', {});
        document.body.appendChild(root);
        const panel = root.lastElementChild;
        const cs = getComputedStyle(panel);
        return { bg: cs.backgroundColor };
      });
      ok('panel uses ivory token (#fcf8f0)', themeState.bg === 'rgb(252, 248, 240)', themeState.bg);
      await page.evaluate(() => document.querySelector('.ts-error-dialog').remove());
    }

    // ---- wiring sanity: static proof of message plumbing -------------------
    console.log('\n--- wiring ---');
    ok("content.js handles OPEN_TABS_PICKER", /msg\.type === "OPEN_TABS_PICKER"/.test(contentSrc));
    ok("content.js sends FOCUS_PICKED_TAB on pick", /type:\s*"FOCUS_PICKED_TAB"/.test(contentSrc));
    ok("showToast routes type==='error' away from the strip",
      /if \(type === 'error'\) \{\s*showErrorDialog\(message\);/.test(contentSrc));
    const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    ok("background.js handles FOCUS_PICKED_TAB", /case "FOCUS_PICKED_TAB":/.test(bgSrc));
  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log(`PASS  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('RUNNER ERROR:', err);
  process.exit(1);
});
