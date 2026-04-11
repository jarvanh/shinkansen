/** @type {import('jest').Config} */
module.exports = {
  // 使用 Node 環境——我們在 helper 裡自己建 jsdom instance，
  // 不用 jest-environment-jsdom，避免雙重 jsdom 衝突。
  testEnvironment: 'node',
  testMatch: ['**/test/jest-unit/**/*.test.cjs'],
  // content.js 的 SPA 導航等待時間是 800ms，加上輪詢和 buffer，
  // 單一測試最多可能需要 ~3 秒。給 10 秒安全餘裕。
  testTimeout: 10000,
};
