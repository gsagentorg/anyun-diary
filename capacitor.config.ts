import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'top.bcw2.anyundiary',
  appName: '安允日记',
  // DEPLOY_TARGET=capacitor npm run build 产出的静态站点目录（根下有 index.html）
  webDir: 'cap',
  // Keep native Playback diagnostics; suppress Capacitor bridge payload dumps.
  ios: { loggingBehavior: 'none', zoomEnabled: false },
  plugins: {
    // 原生壳内全局接管 fetch/XHR，绕过 WKWebView 的 CORS 限制：
    // 运行时后端 /api/catalog 拉取不受跨域约束；音频由原生 AVPlayer 加载
    CapacitorHttp: { enabled: true },
  },
};

export default config;
