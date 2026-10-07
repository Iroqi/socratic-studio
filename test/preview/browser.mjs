// 浏览器臂的公共发现逻辑（test/preview/* 用，不进 npm run test:all）。
//
// 为什么要单独一份：三个探针脚本过去把浏览器写死成
// `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`——那是**一台 Windows 机器**的
// 安装目录。换到 Linux（chromium）、macOS（.app 路径）、或 Edge 装在 Program Files 的机器上，
// 脚本第一句就"找不到 Edge"，浏览器臂整条静默消失，探针退化成"什么都没量到"。
// 探针可以没有浏览器（它不判红绿），但不许因为一个路径常量就假装自己是"跑过了"。
//
// 另一条：`--disable-dev-shm-usage`。容器里 /dev/shm 常常只有 64MB（本沙箱实测如此），
// chromium 默认的共享内存策略会把页面资源往 /dev/shm 堆，堆满就直接崩（残留 chrome 进程
// 还能把后面的跑全带崩）。这条 flag 让它改用临时目录，是 headless chromium 在容器里
// 能稳定跑的前提。

import fs from 'node:fs';
import path from 'node:path';

const WINDOWS_EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const MACOS_CANDIDATES = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
// PATH 里的名字按"最通用"排：Linux 发行版叫法不一，chromium 家族优先，Edge 名字排后。
const PATH_NAMES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'microsoft-edge',
  'microsoft-edge-stable',
  'msedge',
  'brave-browser',
];

function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // 这一档没有，试下一档
      }
    }
  }
  return null;
}

/**
 * 找出一个能用的浏览器可执行文件；找不到返回 null（调用方必须明说"浏览器臂跳过"，
 * 不许静默当跑过了）。顺序：显式指路 → 平台已知路径 → PATH 轮询。
 */
export function findBrowser() {
  const forced = process.env.BROWSER_PATH || process.env.EDGE_PATH;
  if (forced) {
    if (fs.existsSync(forced)) return forced;
    console.log(`⚠ BROWSER_PATH/EDGE_PATH 指的路径不存在：${forced}，改用自动发现`);
  }
  const known = [];
  if (process.platform === 'win32') known.push(...WINDOWS_EDGE_CANDIDATES);
  if (process.platform === 'darwin') known.push(...MACOS_CANDIDATES);
  for (const p of known) {
    if (fs.existsSync(p)) return p;
  }
  for (const name of PATH_NAMES) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/** headless 公共参数：含容器里必须的 --disable-dev-shm-usage。profile 目录由调用方给。 */
export function browserBaseArgs(profileDir, extra = []) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage', // 容器 /dev/shm 小到 64MB 时，不加这条 chromium 随机崩
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
  ];
  /*
   * --no-sandbox 只在"容器里以 root 跑"这一种情况下加，不是无条件加。
   * 实测：本沙箱 uid=0，不带这条浏览器直接起不来（CDP 端口永远不答话，探针就报"Edge 没起来"）；
   * 带上它同一镜像 6 秒内 /json/version 就回。普通用户机器上不加——浏览器自带的沙箱是安全边界，
   * 不该为了省事替所有人拆掉。
   */
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  args.push(...extra);
  return args;
}
