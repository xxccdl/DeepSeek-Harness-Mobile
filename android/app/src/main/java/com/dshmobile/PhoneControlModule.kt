package com.dshmobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.Intent
import android.provider.Settings

/**
 * 手机控制桥接：供 React Native 查询无障碍服务状态、引导用户开启。
 */
class PhoneControlModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule() {

  override fun getName(): String = "PhoneControl"

  /** 无障碍服务是否已启用（以系统设置启用列表为准，instance 缺失也正确返回）。 */
  @ReactMethod
  fun isEnabled(promise: Promise) {
    try {
      promise.resolve(PhoneAccessibilityService.isEnabled(reactContext))
    } catch (e: Exception) {
      promise.reject("status_error", e.message ?: "status error")
    }
  }

  /** 打开系统无障碍设置页，引导用户开启本应用的服务。 */
  @ReactMethod
  fun openSettings(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("settings_error", e.message ?: "open settings error")
    }
  }
}
