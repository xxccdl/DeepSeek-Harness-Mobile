/**
 * 内嵌 Termux 引擎的 JS 桥接层。
 * 封装原生模块 TermuxEngine（解压 / 初始化 / 启动 dsh 服务）。
 */

import { NativeEventEmitter, NativeModules } from 'react-native';

const TermuxEngine: any = NativeModules.TermuxEngine;
const PhoneControl: any = NativeModules.PhoneControl;
const FloatingBall: any = NativeModules.FloatingBall;

export const termuxEvents = new NativeEventEmitter(TermuxEngine);

/** 内嵌环境是否已就绪（bash 与 node 均存在）。 */
export function isReady(): Promise<boolean> {
  return TermuxEngine.isReady();
}

/** 环境是否已完整初始化（dsh 引擎在位，免跑初始化脚本）。 */
export function isInitialized(): Promise<boolean> {
  return TermuxEngine.isInitialized();
}

/** dsh 服务进程是否在运行。 */
export function isRunning(): Promise<boolean> {
  return TermuxEngine.isRunning();
}

/** 解压内嵌 Termux bootstrap（首次启动时调用）。 */
export function extractBootstrap(): Promise<boolean> {
  return TermuxEngine.extractBootstrap();
}

/** 初始化环境：apt 安装 node/dsh，输出进度事件 TermuxEngine/progress。 */
export function initialize(): Promise<boolean> {
  return TermuxEngine.initialize();
}

/** 启动 dsh web 服务（监听 127.0.0.1:port）。 */
export function startDsh(port: number): Promise<boolean> {
  return TermuxEngine.startDsh(port);
}

/** 停止 dsh 服务。 */
export function stopDsh(): Promise<boolean> {
  return TermuxEngine.stopDsh();
}

/** 启动前台服务保活：退后台后 dsh 服务与定时任务继续运行。 */
export function startBackgroundService(): Promise<boolean> {
  return TermuxEngine.startBackgroundService();
}

/** 发送一条系统通知（标题、正文）。 */
export function postNotification(title: string, body: string): Promise<boolean> {
  return TermuxEngine.postNotification(title, body);
}

/** 把一条已交付产物保存到 Download/DeepSeekHarness。 */
export function saveDeliver(path: string, name: string): Promise<boolean> {
  return TermuxEngine.saveDeliver(path, name);
}

/** 上传媒体选择（拍照 / 相册 / 文件）。返回 { base64, mime, name } 或取消时 null。 */
export function pickMedia(kind: 'camera' | 'gallery' | 'file'): Promise<{
  base64: string;
  mime: string;
  name: string;
} | null> {
  return TermuxEngine.pickMedia(kind);
}

/** 请求通知权限（Android 13+ 弹系统授权框）。 */
export function requestNotificationPermission(): Promise<boolean> {
  return TermuxEngine.requestNotificationPermission();
}

/** App 通知开关是否开启（老 targetSdk 上需引导用户去系统设置手动开启）。 */
export function isNotificationEnabled(): Promise<boolean> {
  return TermuxEngine.isNotificationEnabled();
}

/** 跳转到本应用的系统通知设置页。 */
export function openNotificationSettings(): Promise<boolean> {
  return TermuxEngine.openNotificationSettings();
}

/** 手机控制：无障碍服务是否已开启（AI 能否操控手机）。 */
export function isPhoneControlEnabled(): Promise<boolean> {
  return PhoneControl.isEnabled();
}

/** 打开系统无障碍设置页，引导用户开启 DeepSeek Harness 的无障碍服务。 */
export function openAccessibilitySettings(): Promise<boolean> {
  return PhoneControl.openSettings();
}

/** 悬浮球：悬浮窗权限是否已授予。 */
export function floatBallHasPermission(): Promise<boolean> {
  return FloatingBall.hasPermission();
}

/** 悬浮球：服务是否在运行。 */
export function isFloatBallEnabled(): Promise<boolean> {
  return FloatingBall.isEnabled();
}

/** 悬浮球：打开系统「显示在其他应用上层」设置页。 */
export function floatBallRequestPermission(): Promise<boolean> {
  return FloatingBall.requestPermission();
}

/** 悬浮球：启动（需悬浮窗权限，未授权返回 false）。 */
export function floatBallStart(): Promise<boolean> {
  return FloatingBall.start();
}

/** 悬浮球：停止。 */
export function floatBallStop(): Promise<boolean> {
  return FloatingBall.stop();
}

/** 悬浮球：汇总状态（supported / permission / enabled）。 */
export function getFloatBallStatus(): Promise<{
  supported: boolean;
  permission: boolean;
  enabled: boolean;
}> {
  return FloatingBall.getStatus();
}
