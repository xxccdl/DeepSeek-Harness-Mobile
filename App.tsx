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
import { isRunning, isInitialized, extractBootstrap, initialize, startDsh, startBackgroundService, requestNotificationPermission, termuxEvents } from './src/services/termux';

const DEFAULT_PORT = 3080;
// 启动动画（Made by xxccdl 流光）最小展示时长，避免环境就绪后一闪而过
const MIN_SPLASH_MS = 2600;
// 总上限：首次初始化最坏需 8-10 分钟（Debian 容器 apt 内部就有 480s 超时），
// 超过才报超时；期间只要有进度事件就会续期（见 boot 内 armTimeout）。
const BOOT_TIMEOUT_MS = 600000;
// 无任何进度事件超过该时长视为初始化卡死，提前提示重试（解压/部署阶段已发进度事件）
const PROGRESS_IDLE_MS = 90000;

export default function App() {
  // null = 初始化中；number = dsh 服务端口（已就绪）
  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    setError(null);
    setStatus(null);
    const bootStart = Date.now();
    let lastProgress = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    // 进度感知超时：每次收到初始化进度续期（PROGRESS_IDLE_MS），
    // 总时长超过 BOOT_TIMEOUT_MS 或无进度达到 PROGRESS_IDLE_MS 才提示超时。
    const clearTimer = () => { if (timer) clearTimeout(timer); };
    const armTimeout = () => {
      clearTimer();
      const elapsed = Date.now() - bootStart;
      if (elapsed >= BOOT_TIMEOUT_MS) {
        if (mounted) setError('启动超时，请稍后重试（首次初始化需解压内嵌环境，可能较慢）');
        return;
      }
      const wait = Math.min(PROGRESS_IDLE_MS, BOOT_TIMEOUT_MS - elapsed);
      timer = setTimeout(() => {
        if (!mounted) return;
        if (Date.now() - lastProgress >= PROGRESS_IDLE_MS || Date.now() - bootStart >= BOOT_TIMEOUT_MS) {
          setError('启动超时，请稍后重试（首次初始化需解压内嵌环境，可能较慢）');
        } else {
          armTimeout();
        }
      }, wait);
    };

    // 订阅原生初始化进度：有进度即续期超时并刷新启动画面文字
    const progressSub = termuxEvents.addListener('TermuxEngine/progress', (e: { message?: string }) => {
      lastProgress = Date.now();
      if (!mounted) return;
      if (typeof e?.message === 'string' && e.message.length > 0) setStatus(e.message);
      // 初始化仍在推进：若之前误报超时则恢复（用函数式更新避免闭包读到旧值）
      setError(prev => (prev === null ? prev : null));
      armTimeout();
    });
    armTimeout();

    const boot = async () => {
      const finish = async (next: () => void) => {
        clearTimer();
        progressSub.remove();
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
        clearTimer();
        progressSub.remove();
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      }
    };
    boot();
    return () => {
      mounted = false;
      clearTimer();
      progressSub.remove();
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
        <SplashScreen status={status} />
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
