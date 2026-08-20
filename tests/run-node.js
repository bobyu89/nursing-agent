/**
 * run-node.js — 在 Node.js（CI）上執行與 tests.html 完全相同的測試
 *
 * 專案在瀏覽器以 <script> 全域載入、不經打包；本 runner 透過各檔案的
 * module.exports 把同一批函式掛回 globalThis，讓 tests/engine.test.js
 * 一字不改地在兩種環境執行。本機沒有 Node 也沒關係——GitHub Actions 有。
 *
 * 執行：node tests/run-node.js
 */

/* ── 與 tests.html 相同的迷你測試框架 ── */
const TESTS = [];
globalThis.test = (name, fn) => TESTS.push({ name, fn });
globalThis.assert = (cond, msg) => { if (!cond) throw new Error(msg || '條件不成立'); };
globalThis.assertEqual = (actual, expected, msg) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || '值不相等'}\n  期望：${b}\n  實際：${a}`);
};

/* ── 依 index.html 的載入順序把全域函式掛回來 ── */
Object.assign(globalThis, require('../src/data.js'));
Object.assign(globalThis, require('../src/rules.js'));
Object.assign(globalThis, require('../src/engine.js'));
Object.assign(globalThis, require('../src/fhir.js'));
Object.assign(globalThis, require('../src/llm.js'));
Object.assign(globalThis, require('../src/botcore.js'));

require('./engine.test.js');
require('./fhir.test.js');
require('./botcore.test.js');

(async () => {
  let pass = 0, fail = 0;
  for (const t of TESTS) {
    try {
      await t.fn();
      pass += 1;
      console.log('✓ ' + t.name);
    } catch (err) {
      fail += 1;
      console.error('✗ ' + t.name + '\n  ' + String(err.message).replace(/\n/g, '\n  '));
    }
  }
  console.log(fail ? `\n✗ ${fail} 項失敗（${pass} 項通過）` : `\n✓ 全數通過（${pass} 項）`);
  process.exit(fail ? 1 : 0);
})();
