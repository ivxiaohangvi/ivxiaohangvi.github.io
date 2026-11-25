// 本地 JavaScript action：GitHub Runner 只会把 ACTIONS_RUNTIME_TOKEN / ACTIONS_RESULTS_URL
// 注入到 action 进程里（普通 run: 步骤拿不到），所以门禁逻辑必须作为 action 运行。
// 具体实现放在 scripts/wait-pages-artifact.mjs，便于直接跑单元/集成测试。
// 注意：仓库 package.json 是 "type": "module"，本文件必须用 .mjs 才会按 ESM 执行。
const scriptUrl = new URL('../../../scripts/wait-pages-artifact.mjs', import.meta.url);

try {
  const { runCli } = await import(scriptUrl.href);
  await runCli();
} catch (error) {
  console.error(
    `::error::wait-pages-artifact 运行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
