package com.dshmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * 手机控制本地 HTTP 服务（127.0.0.1:3090）。
 *
 * dsh-tool-phone 插件（运行在 Termux 的 Node 进程里）通过它调用原生无障碍服务，
 * 让 AI 能读取屏幕元素并执行点击/滑动/输入等操作。与 dsh web（3080）错开端口。
 *
 * 接口：
 *   GET  /api/status  → { enabled, service }
 *   GET  /api/screen  → { elements: [...], screen: {...} }
 *   POST /api/action  → body { action, ... } → { ok, ... }
 */
object PhoneControlHttp {

  private const val TAG = "PhoneCtrl"
  private const val PORT = 3090

  @Volatile private var server: ServerSocket? = null
  @Volatile private var acceptThread: Thread? = null
  @Volatile private var running = false
  @Volatile private var appContext: Context? = null
  @Volatile private var lastPromptMs = 0L

  /** 启动 HTTP 服务（幂等）。由后台前台服务启动，保证 App 运行期间可用。 */
  @Synchronized
  fun start(context: Context) {
    appContext = context.applicationContext
    if (running) return
    running = true
    acceptThread = Thread({
      try {
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetAddress.getByName("127.0.0.1").let { java.net.InetSocketAddress(it, PORT) }, 8)
        server = socket
        Log.d(TAG, "phone control http listening on 127.0.0.1:$PORT")
        while (running) {
          try {
            val client = socket.accept()
            handle(client)
          } catch (e: Exception) {
            if (running) Log.w(TAG, "accept error: ${e.message}")
          }
        }
      } catch (e: Exception) {
        Log.w(TAG, "phone control http start failed: ${e.message}")
      } finally {
        running = false
      }
    }, "phone-control-http")
    acceptThread?.isDaemon = true
    acceptThread?.start()
  }

  @Synchronized
  fun stop() {
    running = false
    try { server?.close() } catch (_: Exception) {}
    server = null
  }

  // ── 单连接处理（顺序串行即可：AI 调用频率低） ────────────────────────────────

  private fun handle(socket: Socket) {
    try {
      socket.soTimeout = 10000
      val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
      val requestLine = reader.readLine() ?: return
      val parts = requestLine.split(" ")
      if (parts.size < 3) return
      val method = parts[0].uppercase()
      val path = parts[1]

      // CORS 预检请求直接放行（返回空 200，带上允许头）
      if (method == "OPTIONS") {
        writeResponse(socket, "{}")
        return
      }

      // 读取请求头，得到 Content-Length
      var contentLength = 0
      while (true) {
        val line = reader.readLine() ?: break
        if (line.isEmpty()) break
        val idx = line.indexOf(':')
        if (idx > 0 && line.substring(0, idx).trim().equals("content-length", ignoreCase = true)) {
          contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: 0
        }
      }

      var body = ""
      if (method == "POST" && contentLength > 0) {
        val buf = CharArray(contentLength)
        var read = 0
        while (read < contentLength) {
          val n = reader.read(buf, read, contentLength - read)
          if (n < 0) break
          read += n
        }
        body = String(buf, 0, read)
      }

      val response = route(method, path, body)
      writeResponse(socket, response)
    } catch (e: Exception) {
      Log.w(TAG, "handle error: ${e.message}")
      try { writeResponse(socket, "{\"ok\":false,\"error\":\"server error\"}") } catch (_: Exception) {}
    } finally {
      try { socket.close() } catch (_: Exception) {}
    }
  }

  private fun route(method: String, path: String, body: String): String {
    val enabled = PhoneAccessibilityService.isEnabled(appContext)
    return when {
      method == "GET" && path == "/api/status" ->
        JSONObject().put("ok", true).put("enabled", enabled)
          .put("service", PhoneAccessibilityService.SERVICE_ID).toString()

      method == "GET" && path == "/api/screen" ->
        if (enabled && PhoneAccessibilityService.instance != null)
          PhoneAccessibilityService.instance?.dumpScreen()?.toString()
            ?: JSONObject().put("ok", false).put("error", "服务未就绪，请稍后重试").toString()
        else if (enabled) JSONObject().put("ok", false).put("error", "无障碍服务已在设置中开启，但实例尚未就绪，请稍候 1-2 秒重试").toString()
        else notEnabled()

      method == "POST" && path == "/api/action" -> {
        if (!enabled) return notEnabled()
        val service = PhoneAccessibilityService.instance
        if (service == null) {
          return JSONObject().put("ok", false)
            .put("error", "无障碍服务实例尚未就绪（设置中已开启，正在绑定），请稍候重试").toString()
        }
        val payload = try { JSONObject(body) } catch (_: Exception) {
          return JSONObject().put("ok", false).put("error", "请求体不是合法 JSON").toString()
        }
        val action = payload.optString("action", "")
        try {
          when (action) {
            "tap" -> service.tap(payload.optInt("x", -1), payload.optInt("y", -1))
            "tapText" -> service.tapText(payload.optString("text", ""))
            "longPress" -> service.longPress(payload.optInt("x", -1), payload.optInt("y", -1))
            "doubleTap" -> service.doubleTap(payload.optInt("x", -1), payload.optInt("y", -1))
            "swipe" -> service.swipe(
              payload.optInt("x1", 0), payload.optInt("y1", 0),
              payload.optInt("x2", 0), payload.optInt("y2", 0),
              payload.optInt("duration", 300),
            )
            "type" -> service.typeText(payload.optString("text", ""))
            "scroll" -> service.scroll(payload.optString("direction", "down"))
            "key" -> service.pressKey(payload.optString("key", ""))
            "open" -> service.openApp(payload.optString("package", ""))
            "find" -> service.find(payload.optString("text", ""))
            "notifications" -> service.openNotifications()
            "home" -> service.backToHome()
            else -> JSONObject().put("ok", false).put("error", "未知动作：$action")
          }.toString()
        } catch (e: Exception) {
          Log.w(TAG, "action $action failed: ${e.message}")
          JSONObject().put("ok", false).put("error", "执行 $action 失败：${e.message}").toString()
        }
      }

      else -> JSONObject().put("ok", false).put("error", "未找到接口：$method $path").toString()
    }
  }

  private fun notEnabled(): String {
    promptEnable()
    return JSONObject().put("ok", false)
      .put("error", "手机控制未开启：请先到系统设置 → 无障碍 → 开启 DeepSeek Harness 的无障碍服务（已弹出通知引导，点击即可前往开启）。开启后才能操控手机。")
      .put("code", "ACCESSIBILITY_DISABLED").toString()
  }

  /** 无障碍未开启时自动弹系统通知，点击直达无障碍设置页（限频 60 秒，避免刷屏）。 */
  private fun promptEnable() {
    val ctx = appContext ?: return
    val now = System.currentTimeMillis()
    if (now - lastPromptMs < 60_000) return
    lastPromptMs = now
    try {
      val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.createNotificationChannel(
          NotificationChannel("dsh-task", "任务通知", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "AI 任务完成、产物保存等通知"
          },
        )
      }
      val open = PendingIntent.getActivity(
        ctx, 0,
        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(ctx, "dsh-task")
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(ctx)
      }
      val notification = builder
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("开启手机控制")
        .setContentText("AI 想操控手机，但无障碍服务未开启 · 点击前往设置开启")
        .setContentIntent(open)
        .setAutoCancel(true)
        .build()
      manager.notify(3001, notification)
    } catch (e: Exception) {
      Log.w(TAG, "prompt enable failed: ${e.message}")
    }
  }

  private fun writeResponse(socket: Socket, json: String) {
    val bytes = json.toByteArray(Charsets.UTF_8)
    val head = buildString {
      append("HTTP/1.1 200 OK\r\n")
      // 允许 dsh WebView（127.0.0.1:3080）跨端口 fetch 本服务（同主机不同端口也属跨域）
      append("Access-Control-Allow-Origin: *\r\n")
      append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
      append("Access-Control-Allow-Headers: Content-Type\r\n")
      append("Content-Type: application/json; charset=utf-8\r\n")
      append("Content-Length: ").append(bytes.size).append("\r\n")
      append("Connection: close\r\n")
      append("\r\n")
    }
    val out: OutputStream = socket.getOutputStream()
    out.write(head.toByteArray(Charsets.UTF_8))
    out.write(bytes)
    out.flush()
  }
}
