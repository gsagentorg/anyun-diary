import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'top.bcw2.anyundiary',
  appName: '安允日记',
  // DEPLOY_TARGET=capacitor npm run build 产出的静态站点目录（根下有 index.html）
  webDir: 'cap',
  plugins: {
    // 原生壳内全局接管 fetch/XHR，绕过 WKWebView 的 CORS 限制：
    // 任意后端地址的 data.json 拉取不受跨域约束（音频走 <audio> 加载，本就不受 CORS）
    CapacitorHttp: { enabled: true },
  },
};

export default config;
