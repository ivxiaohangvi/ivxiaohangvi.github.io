/**
 * scripts/wait-pages-artifact.mjs 的测试。
 *
 * 1. 轮询逻辑：用假时钟和假产物列表测"已可见 / 第 N 次可见 / 超时 / 探测报错 / 产物重复"。
 * 2. 集成：起一个假的 Actions 产物服务（twirp ListArtifacts），用真实客户端跑脚本，
 *    验证退出码、输出和请求内容与真实环境一致（JSON 请求体、JWT 里的 backend id）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ARTIFACT_NAME, waitForArtifactVisible } from './wait-pages-artifact.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./wait-pages-artifact.mjs', import.meta.url));
const LIST_ARTIFACTS_PATH = '/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts';

function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

function artifact(name = DEFAULT_ARTIFACT_NAME, id = 15006137002) {
  return { name, id, size: 200222488 };
}

test('产物已可见时第一次查询就返回，不再等待', async () => {
  const clock = fakeClock();
  const calls = [];
  const result = await waitForArtifactVisible({
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
    listArtifacts: async () => {
      calls.push(clock.now());
      return { artifacts: [artifact()] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.probeFailed, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.artifact?.id, 15006137002);
  assert.deepEqual(calls, [0]);
});

test('产物第 3 次查询才出现时，按间隔轮询后返回', async () => {
  const clock = fakeClock();
  const responses = [[], [], [artifact()]];
  let index = 0;
  const result = await waitForArtifactVisible({
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
    listArtifacts: async () => ({ artifacts: responses[index++] }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.elapsedMs, 4000); // 两次 2000ms 间隔
});

test('超过等待上限仍未出现时返回失败', async () => {
  const clock = fakeClock();
  const result = await waitForArtifactVisible({
    intervalMs: 1000,
    timeoutMs: 3000,
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
    listArtifacts: async () => ({ artifacts: [] }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 4); // 0s / 1s / 2s / 3s 各查一次
  assert.equal(result.elapsedMs, 3000);
});

test('产物列表为空对象时按"还没出现"处理', async () => {
  const clock = fakeClock();
  const result = await waitForArtifactVisible({
    intervalMs: 500,
    timeoutMs: 500,
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
    listArtifacts: async () => ({}),
  });

  assert.equal(result.ok, false);
});

test('探测报错时 fail-open：放行并标记 probeFailed', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const result = await waitForArtifactVisible({
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
    listArtifacts: async () => {
      attempts += 1;
      throw new Error('Unable to get the ACTIONS_RESULTS_URL env variable');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.probeFailed, true);
  assert.equal(result.attempts, 1);
  assert.equal(attempts, 1);
});

test('同名的重复产物也会判定为可见，并记录数量', async () => {
  const clock = fakeClock();
  const result = await waitForArtifactVisible({
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
    listArtifacts: async () => ({
      artifacts: [artifact(DEFAULT_ARTIFACT_NAME, 1), artifact(DEFAULT_ARTIFACT_NAME, 2), artifact('other', 3)],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.duplicateCount, 2);
  assert.equal(result.artifact?.id, 1);
});

function fakeRuntimeToken() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { scp: 'Actions.Results:run-backend-id:job-backend-id' };
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.test-signature`;
}

function listArtifactsResponse(names) {
  return {
    artifacts: names.map((name) => ({
      workflowRunBackendId: 'run-backend-id',
      workflowJobRunBackendId: 'job-backend-id',
      databaseId: '15006137002',
      name,
      size: '200222488',
      createdAt: '2026-11-25T08:51:42.129Z',
    })),
  };
}

async function startMockResultsServer(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw });
      const { status = 200, body } = respond(requests.length);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RESULTS_URL',
    'ACTIONS_RUNTIME_URL',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function runWaitScript(env, scriptPath = SCRIPT_PATH) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { env, cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('集成：真实客户端对着假产物服务轮询，产物出现后成功退出', async (t) => {
  const responses = [listArtifactsResponse([]), listArtifactsResponse([]), listArtifactsResponse([DEFAULT_ARTIFACT_NAME])];
  let index = 0;
  const server = await startMockResultsServer(() => ({
    body: responses[Math.min(index++, responses.length - 1)],
  }));
  t.after(() => server.close());

  const result = await runWaitScript(
    childEnv({
      ACTIONS_RUNTIME_TOKEN: fakeRuntimeToken(),
      ACTIONS_RESULTS_URL: server.url,
      WAIT_ARTIFACT_INTERVAL_MS: '20',
      WAIT_ARTIFACT_TIMEOUT_MS: '5000',
    }),
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /第 3 次查询发现 1 个 "github-pages" 产物/);
  assert.equal(server.requests.length, 3);
  assert.equal(server.requests[0].method, 'POST');
  assert.equal(server.requests[0].url, LIST_ARTIFACTS_PATH);
  assert.deepEqual(JSON.parse(server.requests[0].body), {
    workflow_run_backend_id: 'run-backend-id',
    workflow_job_run_backend_id: 'job-backend-id',
  });
});

test('集成：产物一直不出现时以错误退出，并提示不要 Re-run', async (t) => {
  const server = await startMockResultsServer(() => ({
    body: listArtifactsResponse([]),
  }));
  t.after(() => server.close());

  const result = await runWaitScript(
    childEnv({
      ACTIONS_RUNTIME_TOKEN: fakeRuntimeToken(),
      ACTIONS_RESULTS_URL: server.url,
      WAIT_ARTIFACT_INTERVAL_MS: '50',
      WAIT_ARTIFACT_TIMEOUT_MS: '200',
    }),
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /::error::等待 200ms 后仍未在 Actions 产物服务里看到 "github-pages" 产物/);
  assert.match(result.stderr, /不要 Re-run 本次运行/);
  assert.ok(server.requests.length >= 2);
});

test('集成：缺少 Actions 运行环境时告警放行（退出码 0）', async () => {
  const result = await runWaitScript(childEnv());

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /跳过等待直接部署/);
  assert.match(result.stdout, /::warning::Actions 产物可见性探测失败/);
});

test('集成：运行时依赖装不上时告警放行（退出码 0）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wait-pages-artifact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scriptCopy = path.join(dir, 'wait-pages-artifact.mjs');
  await copyFile(SCRIPT_PATH, scriptCopy);

  const result = await runWaitScript(childEnv(), scriptCopy);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /无法加载 @actions\/artifact/);
  assert.match(result.stdout, /跳过等待直接部署/);
});
