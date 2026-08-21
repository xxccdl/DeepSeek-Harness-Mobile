/**
 * DeepSeek Harness 手机版 — 入口。
 * 内嵌 Termux 引擎：启动时只显示 "Made by xxccdl" 流光文字（SplashScreen），
 * 后台完成解压/初始化/启动服务，就绪后进入 dsh 界面。功能与电脑桌面版一致。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ChatScreen from './src/screens/ChatScreen';
import SplashScreen from './src/screens/SplashScreen';
import { isRunning, isInitialized, extractBootstrap, initialize, startDsh, startBackgroundService, requestNotificationPermission } from './src/services/termux';

const DEFAULT_PORT = 3080;
// 启动动画（Made by xxccdl 流光）最小展示时长，避免环境就绪后一闪而过
const MIN_SPLASH_MS = 2600;
// 首次初始化（解压内嵌环境 + 引擎）在低端机可能较慢，整体超时后提示重试
const BOOT_TIMEOUT_MS = 180000;

export default function App() {
  // null = 初始化中；number = dsh 服务端口（已就绪）
  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    setError(null);
    const bootStart = Date.now();
    // 整体超时：首次解压环境 + 装 node/dsh 可能较慢，超时后提示重试
    const timeoutId = setTimeout(() => {
      if (mounted) {
        setError('启动超时，请稍后重试（首次初始化需解压内嵌环境，可能较慢）');
      }
    }, BOOT_TIMEOUT_MS);
    const boot = async () => {
      const finish = async (next: () => void) => {
        clearTimeout(timeoutId);
        // 保证启动动画至少展示 MIN_SPLASH_MS
        const rest = MIN_SPLASH_MS - (Date.now() - bootStart);
        if (rest > 0) await new Promise(r => setTimeout(r, rest));
        if (mounted) next();
      };
      try {
        // 自动申请通知权限（Android 13+ 弹系统授权框）
        try {
          await requestNotificationPermission();
        } catch { /* 用户拒绝或旧系统，不阻断 */ }
        // 前台服务保活 + 通知监视器（无论服务是否已在运行，都立即注册）
        try {
          await startBackgroundService();
        } catch { /* 前台服务失败不阻断 */ }
        // 已在运行则直接进入
        if (await isRunning()) {
          finish(() => setPort(DEFAULT_PORT));
          return;
        }
        await extractBootstrap();
        // 已完整初始化过则跳过初始化脚本（飞速启动），否则跑首次初始化
        if (await isInitialized()) {
          const started = await startDsh(DEFAULT_PORT);
          if (started) {
            finish(() => setPort(DEFAULT_PORT));
          } else if (mounted) setError('dsh 服务启动失败，请重试');
        } else {
          await initialize();
          const started = await startDsh(DEFAULT_PORT);
          if (started) {
            finish(() => setPort(DEFAULT_PORT));
          } else if (mounted) setError('dsh 服务启动失败，请重试');
        }
      } catch (e) {
        clearTimeout(timeoutId);
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      }
    };
    boot();
    return () => {
      mounted = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      {port !== null ? (
        <ChatScreen port={port} onBack={() => setPort(null)} />
      ) : error !== null ? (
        <View style={styles.errRoot}>
          <Text style={styles.errTitle}>无法启动</Text>
          <Text style={styles.errDetail}>{error}</Text>
          <Pressable
            style={({ pressed }) => [styles.retryBtn, pressed && styles.btnPressed]}
            onPress={retry}
          >
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : (
        <SplashScreen />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  errRoot: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  errTitle: { color: '#e6edf3', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  errDetail: {
    color: '#8b95a5',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 20,
  },
  retryBtn: {
    backgroundColor: '#4d6bfe',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  retryText: { color: '#0d1117', fontSize: 14, fontWeight: '700' },
  btnPressed: { opacity: 0.7 },
});
