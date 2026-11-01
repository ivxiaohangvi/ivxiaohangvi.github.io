/** 全站唯一配置入口：改成你自己的信息即可 */

export const siteConfig = {
  /** 站点名（浏览器标题、RSS、元信息）。文字统一用 moxo；页头页脚的字标另由 Wordmark 渲染为 m∞ */
  title: 'moxo',
  /** 浏览器标题里使用的一句完整描述 */
  siteTitle: 'moxo · 小航的无限空间',
  /** 站点描述（SEO / RSS / llms.txt） */
  description: '小航的无限空间——迹忆、动态、摄影、小工具，以及所有无处安放的心情。',
  /** 线上地址（与 astro.config.mjs 保持一致） */
  url: 'https://moxo.cc',
  /** 作者名 */
  author: '小航',
  /** 英文名 / 昵称 */
  alias: 'ivxiaohangvi',
  /** 一句话身份 */
  tagline: '背井离江的汤姆',
  /** 人格标签（首页展示用） */
  identity: ['INFP', '迹忆', '观察', '创造', '无限可能'],
  /** 社交链接：留空则前端不渲染对应入口 */
  social: {
    github: 'https://github.com/ivxiaohangvi', 
    steam: 'https://steamcommunity.com/id/IVxiaohangVI/',
  },
  /** 开始写字的年份，用于页脚 */
  startYear: 2026,
  /**
   * giscus 评论（可选）：基于 GitHub Discussions，零服务器。
   * 开启步骤：1) 仓库开启 Discussions；2) 仓库安装 giscus App；
   * 3) 到 https://giscus.app 按提示生成 repo / repoId / categoryId 填到下面。
   * 留空（repo 为空字符串）则前端完全不渲染评论区。
   */
  giscus: {
    repo: '', // 例：'your-username/your-repo'
    repoId: '',
    category: 'Announcements',
    categoryId: '',
  },
};

/** 主导航：Header 与 Footer 共用，避免两处各写一份 */
export const navItems = [
  { href: '/', label: '首页' },
  { href: '/diary/', label: '迹忆' },
  { href: '/moments/', label: '动态' },
  { href: '/photos/', label: '摄影' },
  { href: '/tools/', label: '工具' },
  { href: '/blog/', label: '文章' },
  { href: '/about/', label: '关于' },
];

/** 站内链接统一走这里拼接：配置了 base 路径（项目页仓库）后链接依然正确 */
export const withBase = (path: string): string => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
};
