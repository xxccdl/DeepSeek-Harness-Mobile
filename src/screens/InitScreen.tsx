/**
 * 初始化界面：解压内嵌 Termux bootstrap → 安装 node/dsh → 启动服务。
 * 全程自动，展示进度与日志。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isReady, extractBootstrap, initialize, startDsh, termuxEvents } from '../services/termux';

const DEFAULT_PORT = 3080;

type Phase = 'checking' | 'extracting' | 'installing' | 'starting' | 'error' | 'done';

interface Props {
  onReady: (port: number) => void;
  onError?: () => void;
}

export default function InitScreen({ onReady, onError }: Props) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const appendLog = useCallback((line: string) => {
    setLogs(prev => {
      const next = [...prev, line];
      return next.slice(-200);
    });
  }, []);

  const run = useCallback(async () => {
    try {
      setPhase('checking');
      // 1. 解压 bootstrap（幂等：已解压过则只修复符号链接）
      setPhase('extracting');
      appendLog('检查并解压内嵌 Termux 环境…');
      await extractBootstrap();

      // 2. 配置 node/dsh/插件（脚本幂等：node 已存在则跳过解压）
      setPhase('installing');
      appendLog('配置 dsh 引擎与插件…');
      await initialize();

      // 3. 启动 dsh 服务
      setPhase('starting');
      appendLog(`启动 dsh 服务 (127.0.0.1:${DEFAULT_PORT})…`);
      const started = await startDsh(DEFAULT_PORT);
      if (!started) {
        setPhase('error');
        setError('dsh 服务启动失败，请重试');
        onError?.();
        return;
      }
      setPhase('done');
      appendLog('dsh 服务已就绪');
      setTimeout(() => onReady(DEFAULT_PORT), 400);
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : String(e));
      onError?.();
    }
  }, [appendLog, onReady, onError]);

  useEffect(() => {
    const sub = termuxEvents.addListener('TermuxEngine/progress', (evt: any) => {
      const msg: string = evt?.message ?? '';
      if (msg.trim().length > 0) appendLog(msg);
      if (evt?.progress === 100) appendLog('环境初始化完成');
    });
    run();
    return () => sub.remove();
  }, [run, appendLog]);

  // 日志自动滚动到底部
  const onContentSizeChange = useCallback(() => {
    // 内容变化后维持视口
  }, []);

  const phaseText: Record<Phase, string> = {
    checking: '正在检查环境…',
    extracting: '正在解压内嵌环境…',
    installing: '正在配置 dsh 引擎…',
    starting: '正在启动服务…',
    error: '初始化失败',
    done: '已就绪',
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.container}>
        <View style={styles.brand}>
          <View style={styles.logoWrap}>
            <View style={styles.logo}>
              <View style={styles.logoCore} />
            </View>
          </View>
          <Text style={styles.title}>DeepSeek Harness</Text>
          <Text style={styles.subtitle}>手机版 · 环境初始化</Text>
        </View>

        <View style={styles.statusRow}>
          <ActivityIndicator color="#4d6bfe" />
          <Text style={styles.statusText}>{phaseText[phase]}</Text>
        </View>

        {error !== null && (
          <View style={styles.errBox}>
            <Text style={styles.errText}>{error}</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && styles.btnPressed]}
              onPress={() => {
                setError(null);
                setLogs([]);
                run();
              }}
            >
              <Text style={styles.retryBtnText}>重试</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.logBox}>
          <ScrollView style={styles.logScroll} onContentSizeChange={onContentSizeChange}>
            {logs.length === 0 ? (
              <Text style={styles.logEmpty}>初始化日志将显示在这里</Text>
            ) : (
              logs.map((line, i) => (
                <Text key={i} style={styles.logLine}>
                  {line}
                </Text>
              ))
            )}
          </ScrollView>
        </View>

        <Text style={styles.hint}>
          首次初始化会自动安装完整 dsh 引擎，功能与电脑桌面版一致。{'\n'}请保持网络畅通。
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b0e14' },
  container: { flex: 1, padding: 20 },
  brand: { alignItems: 'center', paddingTop: 36, paddingBottom: 20 },
  logoWrap: { marginBottom: 14 },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#1a2233',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#27334d',
  },
  logoCore: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#4d6bfe',
    opacity: 0.9,
  },
  title: { color: '#e6edf3', fontSize: 20, fontWeight: '700', letterSpacing: 0.3 },
  subtitle: { color: '#4d6bfe', fontSize: 12, fontWeight: '600', marginTop: 4, letterSpacing: 1.5 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  statusText: { color: '#c9d3e0', fontSize: 14, marginLeft: 10 },
  errBox: {
    backgroundColor: '#2a1315',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#4a2026',
    padding: 12,
    marginBottom: 12,
  },
  errText: { color: '#e06c75', fontSize: 13, lineHeight: 18 },
  retryBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: '#4d6bfe',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  retryBtnText: { color: '#0d1117', fontSize: 13, fontWeight: '700' },
  btnPressed: { opacity: 0.7 },
  logBox: {
    flex: 1,
    backgroundColor: '#0d1117',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e2635',
    padding: 10,
    minHeight: 140,
  },
  logScroll: { flexGrow: 0 },
  logEmpty: { color: '#5b6472', fontSize: 12.5 },
  logLine: { color: '#8b95a5', fontSize: 12, lineHeight: 17, fontFamily: 'monospace' },
  hint: { color: '#5b6472', fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 14 },
});
