/**
 * WebView 壳：加载 Termux 内 dsh 服务的完整前端（与桌面版功能一致）。
 * 提供顶部工具条与加载/错误状态处理。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { pingHost } from '../services/dsh';
import {
  floatBallRequestPermission,
  floatBallStart,
  floatBallStop,
  isNotificationEnabled,
  isPhoneControlEnabled,
  openAccessibilitySettings,
  openNotificationSettings,
  pickMedia,
  saveDeliver,
} from '../services/termux';

interface Props {
  port: number;
  onBack: () => void;
}

// 会话级标志：每次 App 启动只自动跳转一次无障碍设置（避免反复打断用户）
let accessibilityAutoPrompted = false;

// WebView 在 react-native-webview 的类型声明里是 FunctionComponent（无实例泛型），
// 但运行时的 Android 实现 forwardRef 暴露了 injectJavaScript 等命令方法。这里用
// handle 接口描述我们用到的 ref 能力，避免与声明类型冲突。
type WebViewHandle = {
  injectJavaScript: (data: string) => void;
};

export default function ChatScreen({ port }: Props) {
  const webViewRef = useRef<WebViewHandle | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [key, setKey] = useState(0);
  // 加载兜底：SPA 前端可能因内部跳转/资源请求使 onLoadEnd 迟迟不触发，
  // 若一直覆盖 loading 遮罩会永久挡住界面。首次加载后 8 秒无论是否完成都隐藏。
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markLoading = useCallback(() => {
    setLoading(true);
    if (loadingTimer.current) clearTimeout(loadingTimer.current);
    loadingTimer.current = setTimeout(() => setLoading(false), 8000);
  }, []);
  const finishLoading = useCallback(() => {
    if (loadingTimer.current) clearTimeout(loadingTimer.current);
    setLoading(false);
  }, []);
  // null = 未知；false = 通知未开启（显示引导横幅）
  const [notifOff, setNotifOff] = useState<boolean | null>(null);
  // null = 未知；false = 手机控制未开启（AI 无法操控手机，显示引导横幅）
  const [phoneOff, setPhoneOff] = useState<boolean | null>(null);
  // 产物保存结果提示（应用内即时反馈）
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setSaveToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setSaveToast(null), 3500);
  }, []);

  useEffect(() => {
    let mounted = true;
    isNotificationEnabled()
      .then(enabled => {
        if (mounted) setNotifOff(!enabled);
      })
      .catch(() => {});
    const checkPhoneControl = () => {
      isPhoneControlEnabled()
        .then(enabled => {
          if (!mounted) return;
          setPhoneOff(!enabled);
          // 自动请求辅助功能权限：首次进入且未开启时，自动打开系统无障碍设置页
          // （Android 安全限制：必须由用户在设置中手动确认开启）
          if (!enabled && !accessibilityAutoPrompted) {
            accessibilityAutoPrompted = true;
            openAccessibilitySettings().catch(() => {});
          }
        })
        .catch(() => {});
    };
    checkPhoneControl();
    // 无障碍状态自动刷新：从系统设置返回、服务被系统杀进程重启后，
    // 顶部横幅/设置页能自动同步最新状态（无需手动重进页面）。
    const phoneTimer = setInterval(checkPhoneControl, 3000);
    return () => {
      mounted = false;
      clearInterval(phoneTimer);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (loadingTimer.current) clearTimeout(loadingTimer.current);
    };
  }, []);

  const url = `http://127.0.0.1:${port}/`;

  const reload = useCallback(() => {
    setKey(k => k + 1);
    markLoading();
    setFatalError(null);
  }, [markLoading]);

  const retry = useCallback(async () => {
    setRetrying(true);
    const alive = await pingHost(port);
    setRetrying(false);
    if (alive) {
      reload();
    } else {
      setFatalError('dsh 服务未在运行，请回到 Termux 重新启动。');
    }
  }, [port, reload]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      // 接收 WebView 内产物「保存」按钮回传，触发原生保存到 Download/DeepSeekHarness
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data?.type === 'save-deliver' && typeof data.path === 'string') {
          const name = typeof data.name === 'string' ? data.name : 'artifact';
          saveDeliver(data.path, name)
            .then(() => showToast(`已保存到 Download/DeepSeekHarness/${name}`))
            .catch(() => showToast('保存失败，请检查通知权限'));
        } else if (data?.type === 'open-accessibility') {
          // 设置页「开启手机控制」按钮：跳转系统无障碍设置
          openAccessibilitySettings().catch(() => {});
        } else if (data?.type === 'floatball-open-settings') {
          // 悬浮球：打开系统悬浮窗权限设置页
          floatBallRequestPermission().catch(() => {});
        } else if (data?.type === 'floatball-start') {
          // 悬浮球：启动
          floatBallStart().catch(() => {});
        } else if (data?.type === 'floatball-stop') {
          // 悬浮球：停止
          floatBallStop().catch(() => {});
        } else if (data?.type === 'mobile-pick-media' && typeof data.kind === 'string') {
          // 「+」上传：调原生相机/相册/文件选择，结果 base64 回传 Web 注入 composer
          const kind = data.kind;
          pickMedia(kind as 'camera' | 'gallery' | 'file')
            .then(result => {
              if (result == null) return; // 用户取消
              webViewRef.current?.injectJavaScript(
                `window.__dshAttachMedia(${JSON.stringify(result.base64)},${JSON.stringify(result.mime)},${JSON.stringify(result.name)}); true;`,
              );
            })
            .catch(() => {
              webViewRef.current?.injectJavaScript(
                `window.__dshAttachMedia(null, null, null); true;`,
              );
            });
        } else if (data?.type === 'open-url' && typeof data.url === 'string') {
          // 检查更新「去 GitHub 下载」：用系统浏览器打开链接
          Linking.openURL(data.url).catch(() => {});
        }
      } catch {
        // 忽略非 JSON 或无关消息
      }
    },
    [showToast],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* 通知未开启引导横幅 */}
      {notifOff === true && (
        <Pressable
          style={({ pressed }) => [styles.notifBanner, pressed && styles.bannerPressed]}
          onPress={() => {
            openNotificationSettings().catch(() => {});
            setNotifOff(null);
          }}
        >
          <Text style={styles.notifBannerText}>
            通知未开启，AI 任务完成将无法提醒 · 点击开启
          </Text>
        </Pressable>
      )}
      {/* 手机控制未开启引导横幅 */}
      {phoneOff === true && (
        <Pressable
          style={({ pressed }) => [styles.phoneBanner, pressed && styles.bannerPressed]}
          onPress={() => {
            openAccessibilitySettings().catch(() => {});
            setPhoneOff(null);
          }}
        >
          <Text style={styles.phoneBannerText}>
            手机控制未开启，AI 无法操控手机 · 点击前往无障碍设置开启
          </Text>
        </Pressable>
      )}
      {fatalError !== null ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorTitle}>无法连接</Text>
          <Text style={styles.errorDetail}>{fatalError}</Text>
          <Pressable
            style={({ pressed }) => [styles.retryBtn, pressed && styles.btnPressed]}
            onPress={retry}
            disabled={retrying}
          >
            {retrying ? (
              <ActivityIndicator color="#0d1117" />
            ) : (
              <Text style={styles.retryBtnText}>重新检测并重试</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.webWrap}>
          <WebView
            ref={webViewRef as never}
            key={key}
            source={{ uri: url }}
            style={styles.web}
            originWhitelist={['http://127.0.0.1', 'http://localhost']}
            javaScriptEnabled
            domStorageEnabled
            allowFileAccess
            setSupportMultipleWindows={false}
            onLoadStart={markLoading}
            onLoadEnd={finishLoading}
            onError={() => {
              setFatalError('加载失败，请确认 dsh 服务正在 Termux 中运行。');
              finishLoading();
            }}
            // Android WebView 渲染进程被杀（如内存压力）时自动重载，避免白屏卡死
            onContentProcessTerminated={reload}
            onHttpError={event => {
              const status = event.nativeEvent.statusCode;
              if (status === 426 || status === 404) {
                // 前端资源缺失：通常意味着服务未就绪或端口错误。
                setFatalError('dsh 服务响应异常，请确认端口与 Termux 中的启动参数一致。');
                finishLoading();
              }
            }}
            onMessage={handleMessage}
          />
          {loading && (
            <View style={styles.loadingMask} pointerEvents="none">
              <ActivityIndicator color="#4d6bfe" size="large" />
              <Text style={styles.loadingText}>正在加载 dsh 界面…</Text>
            </View>
          )}
        </View>
      )}
      {/* 保存结果即时反馈（App 内可见，不依赖系统通知） */}
      {saveToast !== null && (
        <View style={styles.saveToastWrap} pointerEvents="none">
          <Text style={styles.saveToastText}>{saveToast}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b0e14' },
  notifBanner: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    backgroundColor: '#1d2b4d',
    borderBottomWidth: 1,
    borderBottomColor: '#2c3f6b',
  },
  phoneBanner: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    backgroundColor: '#2d2a1a',
    borderBottomWidth: 1,
    borderBottomColor: '#4a4526',
  },
  phoneBannerText: {
    color: '#f0d489',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  saveToastWrap: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 28,
    backgroundColor: '#1c2733',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  saveToastText: { color: '#9fd3a5', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  bannerPressed: { backgroundColor: '#274071' },
  notifBannerText: {
    color: '#a9c2ff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  webWrap: { flex: 1 },
  web: { flex: 1, backgroundColor: '#0b0e14' },
  loadingMask: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b0e14',
  },
  loadingText: { color: '#8b95a5', fontSize: 13, marginTop: 12 },
  errorWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  errorTitle: { color: '#e6edf3', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  errorDetail: {
    color: '#8b95a5',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 20,
  },
  retryBtn: {
    backgroundColor: '#4d6bfe',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  retryBtnText: { color: '#0d1117', fontSize: 14, fontWeight: '700' },
  btnPressed: { opacity: 0.7 },
});
