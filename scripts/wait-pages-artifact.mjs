/**
 * 部署前等待 Pages 产物可见。
 *
 * 背景：upload-pages-artifact 刚上传完，产物在 GitHub 内部的 Actions 产物服务里
 * 还要几十毫秒到几十秒才能被列出来（actions/deploy-pages#451）。deploy-pages 内部
 * 用 @actions/artifact 的 listArtifacts() 查产物，查不到就直接报
 * "No artifacts named "github-pages" were found for this workflow run."，
 * 于是"上传完立刻部署"会偶发失败，即使产物其实已经上传成功。
 *
 * 本脚本用与 deploy-pages 完全相同的客户端和查询，先轮询到产物可见，再让
 * deploy-pages 部署一次。可见性是单调的：这里能查到，deploy-pages 部署时也一定
 * 能查到，所以探测成功就不存在竞态；而部署只调用一次，也不会出现重试导致的重复发布。
 *
 * 探测本身出问题（缺环境变量、网络错误、客户端接口变化）时只告警放行，
 * 让部署退化成没有这层保护时的行为，绝不因为探测故障挡住发布。
 */
import { pathToFileURL } from 'node:url';

export const DEFAULT_ARTIFACT_NAME = 'github-pages';

export const DEFAULT_INTERVAL_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 120000;

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，当前值：${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * 轮询产物列表，直到指定名字的产物可见。
 *
 * @param {object} options
 * @param {() => Promise<{ artifacts?: Array<{ name?: string, id?: number, size?: number }> }>} options.listArtifacts
 *   列出当前 workflow run 产物的函数（测试时可替换）。
 * @param {string} [options.artifactName] 产物名，默认 github-pages。
 * @param {number} [options.intervalMs] 轮询间隔，默认 2000ms。
 * @param {number} [options.timeoutMs] 总等待上限，默认 120000ms。
 * @param {() => number} [options.now] 当前时间（毫秒），测试时可替换。
 * @param {(ms: number) => Promise<void>} [options.sleep] 等待函数，测试时可替换。
 * @param {(message: string) => void} [options.log] 日志函数。
 * @returns {Promise<{ ok: boolean, probeFailed: boolean, attempts: number, elapsedMs: number, artifact?: object, duplicateCount?: number }>}
 */
export async function waitForArtifactVisible({
  listArtifacts,
  artifactName = DEFAULT_ARTIFACT_NAME,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;

    let artifacts;
    try {
      ({ artifacts = [] } = await listArtifacts());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`[wait-pages-artifact] 查询 Actions 产物列表失败（${reason}），跳过等待直接部署`);
      return { ok: true, probeFailed: true, attempts, elapsedMs: now() - startedAt };
    }

    const matches = (artifacts ?? []).filter((item) => item && item.name === artifactName);
    const elapsedMs = now() - startedAt;
    if (matches.length > 0) {
      const [first] = matches;
      log(
        `[wait-pages-artifact] 第 ${attempts} 次查询发现 ${matches.length} 个 "${artifactName}" 产物` +
          `（id=${first?.id ?? '未知'}），已等待 ${elapsedMs}ms`,
      );
      return {
        ok: true,
        probeFailed: false,
        attempts,
        elapsedMs,
        artifact: first,
        duplicateCount: matches.length,
      };
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      log(
        `[wait-pages-artifact] 第 ${attempts} 次查询仍未发现 "${artifactName}" 产物，` +
          `已等待 ${elapsedMs}ms，达到上限 ${timeoutMs}ms`,
      );
      return { ok: false, probeFailed: false, attempts, elapsedMs };
    }

    const nextWaitMs = Math.min(intervalMs, remainingMs);
    log(
      `[wait-pages-artifact] 第 ${attempts} 次查询暂未发现 "${artifactName}" 产物，` +
        `${nextWaitMs}ms 后重试（已等待 ${elapsedMs}ms）`,
    );
    await sleep(nextWaitMs);
  }
}

async function main() {
  const artifactName = process.env.PAGES_ARTIFACT_NAME || DEFAULT_ARTIFACT_NAME;
  const intervalMs = readPositiveIntEnv('WAIT_ARTIFACT_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  const timeoutMs = readPositiveIntEnv('WAIT_ARTIFACT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

  // 动态加载客户端：万一本步骤运行时依赖没装上（例如以后拆分 job 后本 job
  // 不再安装依赖），也只告警放行，不让探测本身挡住发布。
  let client;
  try {
    const artifact = await import('@actions/artifact');
    client = new artifact.DefaultArtifactClient();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`::warning::无法加载 @actions/artifact（${reason}），跳过等待直接部署（部署行为等同于没有这层保护）。`);
    return;
  }

  const result = await waitForArtifactVisible({
    artifactName,
    intervalMs,
    timeoutMs,
    // 与 deploy-pages 一样：不带 findBy，列出当前 workflow run 的产物
    listArtifacts: () => client.listArtifacts(),
  });

  if (!result.ok) {
    console.error(
      `::error::等待 ${timeoutMs}ms 后仍未在 Actions 产物服务里看到 "${artifactName}" 产物，放弃部署。` +
        '若要重试，请重新触发一次工作流，不要 Re-run 本次运行（会在同一次运行里再上传一份产物，deploy-pages 会因产物重复失败）。',
    );
    process.exitCode = 1;
    return;
  }

  if (result.probeFailed) {
    console.log('::warning::Actions 产物可见性探测失败，跳过等待直接部署（部署行为等同于没有这层保护）。');
  } else if (result.duplicateCount > 1) {
    console.log(
      `::warning::发现 ${result.duplicateCount} 个 "${artifactName}" 产物，` +
        'deploy-pages 可能因产物重复失败（通常是 Re-run 同一次运行造成的）。',
    );
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`::error::wait-pages-artifact 运行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
