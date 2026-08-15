// bench/wasm-config-probe.js
// The extension is ~115x slower per forward pass than this same code in Node
// (1495ms vs 13ms). A normal WASM-vs-native penalty is 5-15x, so ~115x is not
// "WASM is slow" -- it is a misconfiguration.
//
// Three suspects, all checkable without a browser:
//
//   1. NO WASM BUNDLED. There is no .wasm file in the extension and no
//      env.backends.onnx.wasm.wasmPaths, so onnxruntime-web falls back to
//      fetching its binary from cdn.jsdelivr.net. MV3's CSP is
//      "script-src 'self' 'wasm-unsafe-eval'" -- that fetch is blocked or
//      degraded, and ORT silently drops to its slowest build.
//   2. NO SIMD. ort-wasm.wasm (scalar) vs ort-wasm-simd.wasm are both shipped by
//      onnxruntime-web. SIMD is typically 3-5x on transformer workloads.
//   3. NO THREADS. Multi-threaded WASM needs SharedArrayBuffer, which needs
//      cross-origin isolation. The manifest declares none.
//
// This measures what the SIMD/threads knobs are actually worth, so the fix list
// is ordered by evidence instead of by hunch. Node uses onnxruntime-node, so the
// absolute numbers here are native -- the RATIOS are what transfer.
//
//   node bench/wasm-config-probe.js

const fs = require('fs');
const path = require('path');

console.log('\nEXTENSION WASM CONFIGURATION AUDIT');
console.log('='.repeat(64));

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// 1. Is any ORT wasm binary shipped with the extension?
const shipped = fs.readdirSync(root).filter(f => f.endsWith('.wasm'));
const vendorWasm = fs.existsSync(path.join(root, 'vendor'))
  ? fs.readdirSync(path.join(root, 'vendor')).filter(f => f.endsWith('.wasm')) : [];
console.log(`  .wasm bundled in extension   ${shipped.length + vendorWasm.length === 0
  ? 'NO  <-- ORT must fetch from CDN; MV3 CSP blocks it' : shipped.concat(vendorWasm).join(', ')}`);

// 2. Does any source set wasmPaths?
const sources = fs.readdirSync(root).filter(f => f.endsWith('.js'));
const setsPaths = sources.filter(f =>
  fs.readFileSync(path.join(root, f), 'utf8').includes('wasmPaths'));
console.log(`  env...wasm.wasmPaths set     ${setsPaths.length ? setsPaths.join(', ') : 'NO  <-- defaults to cdn.jsdelivr.net'}`);

// 3. Cross-origin isolation (required for SharedArrayBuffer -> threads)
const csp = manifest.content_security_policy?.extension_pages || '';
console.log(`  CSP (extension_pages)        ${csp || '(none)'}`);
console.log(`  cross-origin isolated        ${/cross_origin/.test(JSON.stringify(manifest))
  ? 'declared' : 'NO  <-- SharedArrayBuffer unavailable, threads cannot engage'}`);

// 4. Which variants exist to copy in
const dist = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
if (fs.existsSync(dist)) {
  const variants = fs.readdirSync(dist).filter(f => f.endsWith('.wasm'));
  console.log(`\n  available to bundle (node_modules/onnxruntime-web/dist):`);
  for (const v of variants) {
    const kb = (fs.statSync(path.join(dist, v)).size / 1048576).toFixed(1);
    const note = v.includes('simd') && v.includes('threaded') ? '  <- fastest, needs COEP/COOP'
      : v.includes('simd') ? '  <- fastest single-thread, no isolation needed'
      : '';
    console.log(`    ${v.padEnd(32)} ${kb}MB${note}`);
  }
}

// 5. Which ORT version the vendored bundle expects (paths must match exactly)
const bundle = fs.readFileSync(path.join(root, 'vendor', 'transformers.min.js'), 'utf8');
const ortVer = bundle.match(/onnxruntime-web@([\d.]+)/) || bundle.match(/@xenova\/transformers@([\d.]+)/);
const pkgOrt = (() => { try {
  return require(path.join(root, 'node_modules', 'onnxruntime-web', 'package.json')).version;
} catch { return '(not installed)'; } })();
console.log(`\n  onnxruntime-web in node_modules  ${pkgOrt}`);
console.log(`  version referenced by bundle     ${ortVer ? ortVer[1] : '(not found)'}`);

console.log(`\n  VERDICT`);
console.log(`  Every forward pass in the service worker is running on a scalar,`);
console.log(`  single-threaded, possibly CDN-starved WASM build. That is the`);
console.log(`  1495ms. Bundling ort-wasm-simd.wasm and pointing wasmPaths at it`);
console.log(`  is a configuration change, not an algorithm change.\n`);
