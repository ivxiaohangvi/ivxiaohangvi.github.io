// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // 自定义域名：canonical / RSS / sitemap / llms.txt 都用它生成绝对链接。
  // 换域名时，这里和 public/CNAME、public/robots.txt 三处一起改。
  site: 'https://moxo.cc',

  // 只有当站点部署成 username.github.io/<仓库名>/ 这样的项目页时才需要 base；
  // 本仓库是自定义域名挂在根路径，保持注释。注意：即使没绑域名，
  // ivxiaohangvi.github.io 也是「用户页」，根路径就是 /，base 同样不该打开。
  // base: '/<仓库名>/',

  integrations: [
    sitemap({
      // 日记、动态与 void 页不进 sitemap：它们对搜索引擎是 noindex 的私人页面
      filter: (page) => !/^\/(diary|moments|void)(\/|$)/.test(new URL(page).pathname),
    }),
  ],

  // 暗房页（/infinity/）只在浏览器端用 three；不预先声明的话，Vite 会在第一次
  // 访问该页时才「发现新依赖」并重新预构建，已打开的页面会拿到一堆
  // 504 Outdated Optimize Dep，三维脚本整个不执行，加载文案就永远停在「正在显影」。
  vite: {
    optimizeDeps: {
      include: [
        'three',
        'three/examples/jsm/controls/OrbitControls.js',
        'three/examples/jsm/loaders/GLTFLoader.js',
        'three/examples/jsm/loaders/DRACOLoader.js',
        'three/examples/jsm/environments/RoomEnvironment.js',
      ],
    },

    // 本地 dev 里没有 Cloudflare Worker，/api/steam-status 会 404。
    // 开发服务器把这条路径转发到线上，关于页的 Steam 一行在本地也是活的；
    // 别的路径一律不经过代理，避免本地把线上页面也代理进来。
    server: {
      proxy: {
        '/api/steam-status': {
          target: 'https://moxo.cc',
          changeOrigin: true,
          secure: true,
        },
      },

      // vault 里是 Base64 存档，体积不小，监听它只是白耗文件句柄。
      watch: {
        ignored: ['**/vault/**', '**/dist/**', '**/.astro/**'],
      },
    },
  },
});
