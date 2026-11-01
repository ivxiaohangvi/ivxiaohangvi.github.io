// 记录这次构建对应哪一次提交，供「关于」页的状态栏显示「最后提交」。
//
// 在 GitHub Actions 里 git 信息是现成的（checkout 之后 `git log -1` 就能拿到
// 本次 HEAD 的提交时间）；本地跑或者没有 .git 时静默留空，页面会退化成
// 「本地构建」，不会因为读不到仓库而报错。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'src', 'data', 'push-info.json');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const commitAt = git(['log', '-1', '--format=%cI']);
const commit = git(['rev-parse', '--short=7', 'HEAD']);

const info = {
  builtAt: new Date().toISOString(),
  commitAt: commitAt || null,
  commit: commit || null,
  repo: process.env.GITHUB_REPOSITORY ?? null,
  ref: process.env.GITHUB_REF_NAME ?? null,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.log(`· push-info: ${commitAt ? `${commit} @ ${commitAt}` : '没有 git 信息（本地构建）'}`);
