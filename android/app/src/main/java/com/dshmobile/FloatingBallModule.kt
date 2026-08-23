package com.dshmobile

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments

/**
 * 悬浮球桥接：供 React Native 查询悬浮窗权限/服务状态，并启动或停止悬浮球。
 */
class FloatingBallModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule() {

  override fun getName(): String = "FloatingBall"

  /** 悬浮窗权限是否已授予。 */
  @ReactMethod
  fun hasPermission(promise: Promise) {
    try {
      promise.resolve(FloatingBallService.hasPermission(reactContext))
    } catch (e: Exception) {
      promise.reject("permission_error", e.message ?: "permission error")
    }
  }

  /** 悬浮球服务是否在运行。 */
  @ReactMethod
  fun isEnabled(promise: Promise) {
    try {
      promise.resolve(FloatingBallService.isRunning())
    } catch (e: Exception) {
      promise.reject("status_error", e.message ?: "status error")
    }
  }

  /** 打开系统「显示在其他应用上层」设置页，引导用户授权悬浮窗权限。
   *  ColorOS/OPPO 等定制 ROM 上 ACTION_MANAGE_OVERLAY_PERMISSION + package URI
   *  常跳转失败或列表里找不到应用，先尝试直达悬浮窗页，失败则回退到应用详情页
   *  （详情页含「显示在其他应用上层」入口，稳定可找到）。 */
  @ReactMethod
  fun requestPermission(promise: Promise) {
    try {
      var opened = false
      // 首选：直达本应用悬浮窗权限页（标准 Android）
      runCatching {
        val intent = Intent(
          Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
          Uri.parse("package:${reactContext.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        reactContext.startActivity(intent)
        opened = true
      }
      if (!opened) {
        // 回退：打开本应用详情页（含「显示在其他应用上层」入口，ColorOS 稳定可找到）
        runCatching {
          val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${reactContext.packageName}"),
          ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          reactContext.startActivity(intent)
          opened = true
        }
      }
      promise.resolve(opened)
    } catch (e: Exception) {
      promise.reject("settings_error", e.message ?: "open overlay settings error")
    }
  }

  /** 启动悬浮球（需要悬浮窗权限，否则直接返回 false）。 */
  @ReactMethod
  fun start(promise: Promise) {
    try {
      if (!FloatingBallService.hasPermission(reactContext)) {
        promise.resolve(false)
        return
      }
      reactContext.startService(Intent(reactContext, FloatingBallService::class.java))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("start_error", e.message ?: "start error")
    }
  }

  /** 停止悬浮球。 */
  @ReactMethod
  fun stop(promise: Promise) {
    try {
      reactContext.stopService(Intent(reactContext, FloatingBallService::class.java))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("stop_error", e.message ?: "stop error")
    }
  }

  /** 汇总状态：{ supported, permission, enabled }。 */
  @ReactMethod
  fun getStatus(promise: Promise) {
    try {
      val map: WritableMap = Arguments.createMap()
      map.putBoolean("supported", true)
      map.putBoolean("permission", FloatingBallService.hasPermission(reactContext))
      map.putBoolean("enabled", FloatingBallService.isRunning())
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("status_error", e.message ?: "status error")
    }
  }
}
