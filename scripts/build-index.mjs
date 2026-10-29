/**
 * 自动重建插件市场索引（format 1）。
 *
 * 数据来源全部走 GitHub API：每个插件仓库取「最新的 vX.Y.Z tag」，
 * 版本号与该 tag 的 commit 直接写进索引，不再手工维护 commit。
 *
 * 用法: GH_TOKEN=xxx node scripts/build-index.mjs [--dry-run]
 */

import fs from 'node:fs'
import path from 'node:path'

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
const API = 'https://api.github.com'
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'market-index.json')
const DRY = process.argv.includes('--dry-run')

/** 每个插件的展示信息（仓库名 -> 索引条目元数据）。新增插件在这里加一项即可。 */
const PLUGINS = [
  {
    repo: 'doraasn/dsh-quota-board',
    title: { zh: '额度看板', en: 'Quota Board' },
    description: {
      zh: '侧栏卡片显示 Codex 的 5 小时 / 周额度与重置次数，以及任意 OpenAI 兼容中转站、DeepSeek、智谱 Z.AI 的余额。支持多供应商、多账号、拖动排序、显示开关与字段映射。',
      en: 'Sidebar cards for Codex 5-hour and weekly limits plus balances of any OpenAI-compatible relay, DeepSeek and Zhipu Z.AI.',
    },
    category: 'quota',
    labels: ['codex', 'sidebar', 'no-deps'],
    keywords: ['quota', 'balance', 'codex', 'sidebar', 'deepseek', 'zai'],
    added: 1792659600,
  },
  {
    repo: 'doraasn/dsh-cloud-sync',
    title: { zh: '云同步', en: 'Cloud Sync' },
    description: {
      zh: '把 DSH 的技能、插件、MCP 配置、全局指令与可选凭据备份到任意 WebDAV，并可按快照恢复。',
      en: 'Back up DSH skills, plugins, MCP config, AGENTS.md and optional credentials to any WebDAV, and restore from snapshots.',
    },
    category: 'backup',
    labels: ['webdav', 'no-deps'],
    keywords: ['webdav', 'backup', 'sync', 'cloud'],
    added: 1792648064,
  },
  {
    repo: 'doraasn/dsh-web-chat',
    title: { zh: '网页会话', en: 'Web Chat' },
    description: {
      zh: '侧栏嵌入 chat.deepseek.com，切换面板不重载，记住上次会话并恢复登录状态。',
      en: 'Embed chat.deepseek.com in a sidebar panel, keep it alive across switches, remember the last conversation and restore the login snapshot.',
    },
    category: 'chat',
    labels: ['sidebar'],
    keywords: ['chat', 'deepseek', 'webview', 'sidebar'],
    added: 1792659600,
  },
  {
    repo: 'doraasn/dsh-sidebar-compact',
    title: { zh: '侧栏收纳', en: 'Sidebar Compact' },
    description: {
      zh: '侧栏只保留勾选的入口（默认只有聊天），插件、跨会话消息、自动化任务等全局面板收进「更多」菜单；留哪个、收哪个在 设置 → 侧栏收纳 里逐个勾选。',
      en: 'Keep only Chat in the sidebar and fold every other global panel (plugins, session messaging, automations) into the More menu; choose per panel in Settings.',
    },
    category: 'ui',
    labels: ['sidebar', 'no-deps'],
    keywords: ['sidebar', 'layout', 'more-menu', 'compact', 'panels'],
    added: 1793340000,
  },
  {
    repo: 'doraasn/dsh-mobile-settings',
    title: { zh: '移动访问设置', en: 'Mobile Access Settings' },
    description: {
      zh: '在设置里管理移动访问：局域网与远程连接的开关、端口与二维码入口。',
      en: 'Manage mobile access from settings: LAN and remote connection switches, ports and QR entry.',
    },
    category: 'settings',
    labels: ['no-deps'],
    keywords: ['mobile', 'settings', 'lan', 'remote'],
    added: 1792659600,
  },
]

const CATEGORIES = {
  quota: { title: { zh: '额度与用量', en: 'Quota & usage' } },
  ui: { title: { zh: '界面与侧栏', en: 'Layout & sidebar' } },
  backup: { title: { zh: '备份与同步', en: 'Backup & sync' } },
  chat: { title: { zh: '会话与对话', en: 'Chat' } },
  settings: { title: { zh: '设置增强', en: 'Settings' } },
}

const LABELS = {
  codex: { title: { zh: 'Codex', en: 'Codex' } },
  sidebar: { title: { zh: '侧栏', en: 'Sidebar' } },
  webdav: { title: { zh: 'WebDAV', en: 'WebDAV' } },
  'no-deps': { title: { zh: '零依赖', en: 'Zero dependency' } },
}

async function api(path_) {
  const response = await fetch(`${API}${path_}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: TOKEN ? `token ${TOKEN}` : undefined,
      'user-agent': 'dsh-plugins-index-builder',
    },
  })
  if (!response.ok) throw new Error(`${path_} -> HTTP ${response.status}`)
  return response.json()
}

/** 该插件是否已把这一版发布到 npm（发布后索引改用 npm 源，国内用户可直达）。 */
async function npmHas(name, version) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) return false
    const doc = await response.json()
    return Boolean(doc.versions && doc.versions[version])
  } catch {
    return false
  }
}

/** 读某个提交里的文本文件；不存在返回 null。 */
async function fileAt(repo, path_, ref) {
  try {
    const file = await api(`/repos/${repo}/contents/${path_}?ref=${ref}`)
    return Buffer.from(file.content, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * 校验发布身份三处一致：package name、cordis.patch.yml 的 name、client bundle 注册的 id。
 * 任何一处不一致都会让 DSH 启动时报 duplicate factory registration，因此宁可不收录。
 */
async function identityOf(repo, ref) {
  const pkgText = await fileAt(repo, 'package.json', ref)
  if (!pkgText) return { ok: false, reason: '没有 package.json' }
  const pkgName = JSON.parse(pkgText).name
  const patchText = (await fileAt(repo, 'cordis.patch.yml', ref)) || ''
  const clientText = (await fileAt(repo, 'lib/client.js', ref)) || (await fileAt(repo, 'client.js', ref)) || ''
  const patchName = (patchText.match(/name:\s*['"]?([^'"\s]+)['"]?/) || [])[1] || ''
  const clientId = (clientText.match(/id:\s*['"]([^'"]+)['"]/) || [])[1] || ''
  if (pkgName !== patchName || pkgName !== clientId) {
    return { ok: false, reason: `身份不一致 package=${pkgName} patch=${patchName} client=${clientId}` }
  }
  return { ok: true }
}

/** 版本比较（只处理 x.y.z）。 */
function compareVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/** 默认分支 HEAD 及其 package.json 里的版本号。 */
async function headVersion(repo) {
  const repoInfo = await api(`/repos/${repo}`)
  const branch = repoInfo.default_branch || 'main'
  const head = await api(`/repos/${repo}/commits/${branch}`)
  const pkgFile = await api(`/repos/${repo}/contents/package.json?ref=${head.sha}`)
  const pkg = JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf8'))
  return { version: pkg.version, sha: head.sha, publishedAt: head.commit?.committer?.date, fromTag: false }
}

/**
 * 取最新版本：优先 vX.Y.Z tag；没有 tag 的仓库退回默认分支 HEAD。
 * 默认分支的 package.json 版本比最新 tag 还新时也用 HEAD —— 否则发了版忘了打 tag
 * 的仓库会一直停在旧版本（v0.1.0 tag 盖住 main 上的 0.2.0）。
 */
async function latestVersion(repo) {
  const tags = await api(`/repos/${repo}/tags?per_page=100`)
  const versions = tags
    .map((tag) => tag.name)
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .map((name) => name.slice(1))
    .sort(compareVersion)

  let head = null
  try {
    head = await headVersion(repo)
  } catch (error) {
    console.log(`  ${repo} 读默认分支失败，退回 tag：${error.message}`)
  }

  if (!versions.length) {
    return head
  }

  const tagVersion = versions[versions.length - 1]
  if (head && compareVersion(head.version, tagVersion) > 0) {
    return head
  }

  const tagName = `v${tagVersion}`
  const commit = await api(`/repos/${repo}/commits/${tagName}`)
  return { version: tagVersion, sha: commit.sha, publishedAt: commit.commit?.committer?.date, fromTag: true }
}

async function buildEntry(config) {
  const latest = await latestVersion(config.repo)
  if (!latest) {
    console.log(`  跳过 ${config.repo}（没有 vX.Y.Z tag）`)
    return null
  }
  const identity = await identityOf(config.repo, latest.sha)
  if (!identity.ok) {
    console.log(`  跳过 ${config.repo}（${identity.reason}）`)
    return null
  }
  const pkgFile = await api(`/repos/${config.repo}/contents/package.json?ref=${latest.sha}`)
  const pkg = JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf8'))
  const useNpm = await npmHas(pkg.name, latest.version)
  console.log(`  ${config.repo}  v${latest.version}${latest.fromTag ? ' (tag)' : ' (head)'} -> ${latest.sha.slice(0, 8)}  name=${pkg.name}  source=${useNpm ? 'npm' : 'git'}`)
  return {
    name: pkg.name,
    title: config.title,
    description: config.description,
    icon: `https://raw.githubusercontent.com/${config.repo}/main/icon.svg`,
    author: 'doraasn',
    homepage: `https://github.com/${config.repo}`,
    repository: { url: `https://github.com/${config.repo}` },
    metadata: {
      category: config.category,
      keywords: config.keywords,
      labels: config.labels,
      sortKeys: { added: config.added },
    },
    versions: [{
      version: latest.version,
      publishTimestamp: Math.floor(new Date(latest.publishedAt || Date.now()).getTime() / 1000),
      source: useNpm
        ? { type: 'npm' }
        : {
            type: 'git',
            url: `https://github.com/${config.repo}.git`,
            commit: latest.sha,
          },
      engines: pkg.engines?.dsh ? { dsh: pkg.engines.dsh } : undefined,
    }],
  }
}

const entries = []
for (const config of PLUGINS) {
  const entry = await buildEntry(config)
  if (entry) entries.push(entry)
}
entries.sort((left, right) => left.name.localeCompare(right.name))

const doc = {
  format: 1,
  title: { zh: 'doraasn 的 DSH 插件', en: "doraasn's DSH plugins" },
  description: {
    zh: '额度看板、云同步、网页会话、移动访问设置、侧栏收纳——都是我自己写给自己用的 DSH 插件。',
    en: 'Quota board, cloud sync, web chat, mobile access settings and sidebar compact — DSH plugins I built for my own daily use.',
  },
  metadata: {
    categories: CATEGORIES,
    labels: LABELS,
    sortKeys: { added: { title: { zh: '收录时间', en: 'Added' }, order: 'desc' } },
  },
  plugins: entries,
}

const text = JSON.stringify(doc, null, 2) + '\n'
const previous = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
if (previous === text) {
  console.log('索引无变化')
  process.exit(0)
}

if (DRY) {
  console.log('--dry-run：不写文件')
  process.exit(0)
}

fs.writeFileSync(OUT, text)
console.log(`已写入 ${OUT}，${entries.length} 个插件`)
