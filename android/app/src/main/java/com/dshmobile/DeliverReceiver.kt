package com.dshmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * 处理「AI 产物」保存动作：用户点击通知后，把 <files>/deliver 下的产物文件
 * 复制到 Download/DeepSeekHarness（保存逻辑复用 DeliverSaver）。
 */
class DeliverReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val srcPath = intent.getStringExtra("path")
    val name = intent.getStringExtra("name") ?: "artifact"
    if (srcPath.isNullOrEmpty()) return
    try {
      DeliverSaver.save(context, srcPath, name)
      notify(context, "已保存", "已保存到 Download/DeepSeekHarness/$name")
    } catch (e: Exception) {
      notify(context, "保存失败", e.message ?: "保存失败")
    }
  }

  private fun notify(context: Context, title: String, body: String) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel("dsh-task", "任务通知", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "AI 任务完成、产物保存等通知"
        },
      )
    }
    val open = PendingIntent.getActivity(
      context, 0, Intent(context, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, "dsh-task")
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
    val notification = builder
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(body)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    manager.notify((System.currentTimeMillis() % 100000).toInt(), notification)
  }
}