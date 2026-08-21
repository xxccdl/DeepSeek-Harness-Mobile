package com.dshmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * 前台服务：让 App 退到后台/锁屏后 dsh 服务（Termux 内的 Node 进程）与
 * 定时任务继续运行。通知栏常驻一条"后台运行中"通知，点击回到 App。
 */
class TermuxService : Service() {

    companion object {
        const val CHANNEL_ID = "dsh-bg"
        const val NOTIF_ID = 1001
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "后台运行",
                NotificationManager.IMPORTANCE_LOW,
            )
            channel.description = "DeepSeek Harness 在后台运行，定时任务正常执行"
            manager.createNotificationChannel(channel)
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("DeepSeek Harness")
            .setContentText("正在后台运行，定时任务正常执行")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notification)
        // 启动手机控制本地 HTTP 服务（AI 通过 dsh-tool-phone 调用原生无障碍操作）
        PhoneControlHttp.start(this)
        return START_STICKY
    }
}
