package com.dshmobile

import android.animation.ValueAnimator
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs

/**
 * dsh 悬浮球：在手机桌面（任意应用之上）显示一个 DeepSeek 图标悬浮球。
 *
 * - 拖动：任意移动，松手自动吸附到屏幕边缘（带动画）
 * - 点击：打开 App 主界面
 * - 长按：弹出状态面板（dsh 服务 / 手机控制状态）与「打开应用 / 关闭悬浮球」
 * - 状态点：右下角小圆点实时反映 dsh 服务是否运行（绿=运行，灰=未运行）
 *
 * 需 SYSTEM_ALERT_WINDOW（悬浮窗）权限；权限不足时服务拒绝启动。
 */
class FloatingBallService : Service() {

  companion object {
    private const val TAG = "FloatBall"
    private const val STATUS_URL = "http://127.0.0.1:3080/"
    private const val POLL_MS = 2500L
    /** 探活连续失败时的最大轮询间隔（指数退避上限）。 */
    private const val POLL_MS_DOWN_MAX = 10_000L
    private const val LONG_PRESS_MS = 450L
    private const val BALL_DP = 56
    // 「AI 正在使用的工具」标签尺寸
    private const val PILL_DP = 106
    private const val PILL_GAP_DP = 6
    // 工具结束后标签停留时长：刚结束的工具再显示 1 秒便于看清，然后才淡出消失
    private const val TOOL_HIDE_DELAY_MS = 1000L
    // 当前工具状态文件（dsh-mobile-bridge 插件写入 <files>/status/current-tool.json）
    private const val TOOL_DIR_REL_PATH = "status"
    private const val TOOL_FILE_NAME = "current-tool.json"
    // 悬浮球位置持久化（吸附落边后保存，重启恢复）
    private const val PREFS_NAME = "floatball"
    private const val KEY_X = "ball_x"
    private const val KEY_Y = "ball_y"

    @Volatile
    var running = false
      private set

    fun isRunning(): Boolean = running

    /** 悬浮窗权限是否已授予。 */
    fun hasPermission(ctx: Context?): Boolean =
      ctx != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && Settings.canDrawOverlays(ctx)
  }

  private var wm: WindowManager? = null
  private var ball: View? = null
  private var menu: View? = null
  // 菜单打开时的全屏透明遮罩：点击任意空白处关闭菜单（模态行为）
  private var menuScrim: View? = null
  private val handler = Handler(Looper.getMainLooper())
  private var pollThread: Thread? = null
  private var toolObserver: FileObserver? = null
  // 最近一次已知的屏幕尺寸（旋转/分屏变化检测用）
  private var lastScreenW = 0
  private var lastScreenH = 0

  // 小球位置（px，指图标球左上角；窗口宽出时向左让位给工具标签）
  private var ballX = 0
  private var ballY = 0
  private var downRawX = 0f
  private var downRawY = 0f
  private var downBallX = 0
  private var downBallY = 0
  private var moved = false
  private var longPressTriggered = false
  private var lastStatus: Boolean? = null
  // 「AI 正在使用的工具」标签状态
  @Volatile private var currentTool: String? = null
  private var pillVisible = false
  private var toolAnimator: ValueAnimator? = null
  // 挂起的标签隐藏任务：工具结束 1 秒后才执行淡出；新工具到来时取消
  private var pendingHideRunnable: Runnable? = null

  private val longPressRunnable = Runnable {
    // 触感反馈：确认长按已触发（跟随系统触感设置，无需权限）
    ball?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    showMenu()
  }

  private val touchSlop: Int by lazy { ViewConfiguration.get(this).scaledTouchSlop }

  private val ballParams: WindowManager.LayoutParams by lazy {
    WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = resources.displayMetrics.widthPixels - dp(BALL_DP) - dp(20)
      y = resources.displayMetrics.heightPixels / 2 - dp(BALL_DP)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (running) return START_STICKY
    if (!hasPermission(this)) {
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    startBall()
    startStatusPolling()
    startToolWatcher()
    return START_STICKY
  }

  /**
   * 屏幕旋转 / 分屏 / 自由窗口：按新尺寸钳制位置并重新吸附到原贴边侧，
   * 避免球留在旧坐标跑出屏幕。
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val sw = resources.displayMetrics.widthPixels
    val sh = resources.displayMetrics.heightPixels
    if (sw <= 0 || sh <= 0 || (sw == lastScreenW && sh == lastScreenH)) return
    val bw = dp(BALL_DP)
    // 按旧屏幕判断原贴边方向：球心在左半屏则保持贴左，否则贴右
    val preferLeft = lastScreenW > 0 && ballX + bw / 2 < lastScreenW / 2
    ballX = if (preferLeft) pillTotalPx() else sw - bw
    ballY = ballY.coerceIn(0, sh - bw)
    lastScreenW = sw
    lastScreenH = sh
    applyBallLayout()
    persistPosition()
  }

  override fun onDestroy() {
    running = false
    pollThread?.interrupt()
    pollThread = null
    try { toolObserver?.stopWatching() } catch (_: Exception) {}
    toolObserver = null
    handler.removeCallbacks(longPressRunnable)
    pendingHideRunnable?.let { handler.removeCallbacks(it) }
    pendingHideRunnable = null
    try { menuScrim?.let { wm?.removeView(it) } } catch (_: Exception) {}
    try { ball?.let { wm?.removeView(it) } } catch (_: Exception) {}
    try { menu?.let { wm?.removeView(it) } } catch (_: Exception) {}
    menuScrim = null
    ball = null
    menu = null
    super.onDestroy()
  }

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  private fun startBall() {
    wm = getSystemService(WINDOW_SERVICE) as WindowManager
    val view = LayoutInflater.from(this).inflate(R.layout.floatball_view, null)
    view.setOnTouchListener(::onBallTouch)
    ball = view
    val sw = resources.displayMetrics.widthPixels
    val sh = resources.displayMetrics.heightPixels
    lastScreenW = sw
    lastScreenH = sh
    // 恢复上次吸附位置（无记录则用默认右侧居中），并钳制进当前屏幕
    val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
    ballX = prefs.getInt(KEY_X, sw - dp(BALL_DP) - dp(20)).coerceIn(0, (sw - dp(BALL_DP)).coerceAtLeast(0))
    ballY = prefs.getInt(KEY_Y, sh / 2 - dp(BALL_DP)).coerceIn(0, (sh - dp(BALL_DP)).coerceAtLeast(0))
    ballParams.x = ballX - pillTotalPx()
    ballParams.y = ballY
    wm?.addView(view, ballParams)
    setStatus(false)
  }

  private fun onBallTouch(v: View, e: MotionEvent): Boolean {
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downRawX = e.rawX
        downRawY = e.rawY
        downBallX = ballX
        downBallY = ballY
        moved = false
        longPressTriggered = false
        handler.removeCallbacks(longPressRunnable)
        handler.postDelayed(longPressRunnable, LONG_PRESS_MS)
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = e.rawX - downRawX
        val dy = e.rawY - downRawY
        if (!moved && (abs(dx) > touchSlop || abs(dy) > touchSlop)) {
          moved = true
          handler.removeCallbacks(longPressRunnable)
        }
        if (moved && !longPressTriggered) {
          // 钳制进屏幕范围，避免拖出可视区域
          ballX = (downBallX + dx).toInt()
            .coerceIn(0, (resources.displayMetrics.widthPixels - dp(BALL_DP)).coerceAtLeast(0))
          ballY = (downBallY + dy).toInt()
            .coerceIn(0, (resources.displayMetrics.heightPixels - dp(BALL_DP)).coerceAtLeast(0))
          updateBallPosition()
        }
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        handler.removeCallbacks(longPressRunnable)
        if (longPressTriggered) return true
        if (!moved) {
          if (menu != null) hideMenu() else openApp()
        } else {
          snapToEdge()
        }
        return true
      }
    }
    return false
  }

  private fun updateBallPosition() {
    applyBallLayout()
  }

  /** 工具标签在左侧展开时占用的宽度（px）。 */
  private fun pillTotalPx(): Int =
    if (pillVisible) dp(PILL_DP + PILL_GAP_DP) else 0

  /** 按当前小球位置 + 标签展开宽度重排窗口（窗口宽 wrap，标签向左扩展）。 */
  private fun applyBallLayout() {
    val p = ball ?: return
    ballParams.x = ballX - pillTotalPx()
    ballParams.y = ballY
    try { wm?.updateViewLayout(p, ballParams) } catch (_: Exception) {}
  }

  private fun snapToEdge() {
    val sw = resources.displayMetrics.widthPixels
    val minX = pillTotalPx()
    val half = dp(BALL_DP) / 2
    val targetX = if (ballX + half < sw / 2) minX else sw - dp(BALL_DP)
    ballY = ballY.coerceIn(0, resources.displayMetrics.heightPixels - dp(BALL_DP))
    val startX = ballX
    val anim = ValueAnimator.ofInt(startX, targetX)
    anim.duration = 220
    anim.interpolator = DecelerateInterpolator()
    anim.addUpdateListener {
      ballX = it.animatedValue as Int
      updateBallPosition()
    }
    anim.addListener(object : android.animation.AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: android.animation.Animator) {
        // 落边触感 + 位置落盘（此后重启恢复到同一位置）
        ball?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        persistPosition()
      }
    })
    anim.start()
  }

  /** 把当前球位置写入 SharedPreferences（吸附落边 / 屏幕变化重吸附时调用）。 */
  private fun persistPosition() {
    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
      .putInt(KEY_X, ballX)
      .putInt(KEY_Y, ballY)
      .apply()
  }

  private fun openApp() {
    try {
      val i = Intent(this, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      startActivity(i)
    } catch (_: Exception) {}
  }

  private fun setStatus(ok: Boolean) {
    lastStatus = ok
    val dot = ball?.findViewById<View>(R.id.fbStatusDot) ?: return
    dot.backgroundTintList = ColorStateList.valueOf(
      if (ok) 0xFF22C55E.toInt() else 0xFF9CA3AF.toInt(),
    )
  }

  /**
   * dsh 服务探活：成功后 2.5s 一轮；连续失败按 ×2 指数退避（上限 10s），
   * 避免引擎关闭时空转高频打点。工具标签不再走本循环（由 FileObserver 事件驱动）。
   */
  private fun startStatusPolling() {
    pollThread?.interrupt()
    val t = Thread {
      var delay = POLL_MS
      while (running) {
        val ok = probeDsh()
        handler.post {
          val changed = ok != lastStatus
          setStatus(ok)
          // 菜单开着时状态行同步刷新（仅状态变化时重写，避免无谓 setText）
          if (menu != null && changed) refreshMenu()
        }
        delay = if (ok) POLL_MS else (delay * 2).coerceAtMost(POLL_MS_DOWN_MAX)
        try { Thread.sleep(delay) } catch (_: InterruptedException) { break }
      }
    }
    t.isDaemon = true
    t.name = "floatball-status"
    pollThread = t
    t.start()
  }

  private fun probeDsh(): Boolean = try {
    val conn = URL(STATUS_URL).openConnection() as HttpURLConnection
    conn.connectTimeout = 2500
    conn.readTimeout = 2500
    conn.instanceFollowRedirects = false
    val code = conn.responseCode
    conn.disconnect()
    code in 200..399
  } catch (_: Exception) {
    false
  }

  /**
   * 解析状态文件里的工具名。
   * 桥接层全部工具结束时写 {"tool":null}，而 org.json 的 optString 对 JSON null
   * 会返回字面量字符串 "null"（而非回退值 ""，经典怪癖），不归一化悬浮球就会
   * 显示「null」。空串 / "null" / "undefined" 一律视为无工具。
   */
  private fun normalizeToolName(raw: String): String? =
    raw.trim().takeUnless { it.isEmpty() || it == "null" || it == "undefined" }

  /**
   * 读取 current-tool.json。返回 (文件是否读到有效内容, 工具名或 null)：
   * 前者为 false 表示 IO 层面还没读到位（观察器据此重试）；为 true 时即使
   * 无工具也立即生效（second 为 null 即清空标签）。
   */
  private fun readToolStatus(): Pair<Boolean, String?> {
    return try {
      val f = File(File(filesDir, TOOL_DIR_REL_PATH), TOOL_FILE_NAME)
      if (!f.exists()) return false to null
      val text = f.readText()
      if (text.isBlank()) return false to null
      true to normalizeToolName(JSONObject(text).optString("tool", ""))
    } catch (_: Exception) {
      false to null
    }
  }

  /**
   * 监视 <files>/status 目录：dsh-mobile-bridge 插件把「AI 正在使用的工具」
   * 原子写入 current-tool.json（tmp + rename），这里捕获 MOVED_TO/CREATE 即读，
   * 工具标签从 2.5s 轮询改为事件驱动（实时）。启动时先同步读一次存量状态。
   */
  private fun startToolWatcher() {
    if (toolObserver != null) return
    val dir = File(filesDir, TOOL_DIR_REL_PATH)
    dir.mkdirs()
    handler.post { setTool(readToolStatus().second) }
    val observer = object : FileObserver(dir.absolutePath, FileObserver.CREATE or FileObserver.MOVED_TO) {
      override fun onEvent(event: Int, path: String?) {
        // 只关心目标文件；.tmp 是写入中的临时文件，rename 完成才会出现在目录里
        if (path != TOOL_FILE_NAME) return
        // 独立线程读取：rename 原子完成后内容即完整，仍留小重试兜底极端 IO 时序；
        // 只有「没读到内容」才重试，「读到但无工具」直接生效不重试
        Thread {
          var status: Pair<Boolean, String?> = false to null
          for (i in 0 until 5) {
            status = readToolStatus()
            if (status.first) break
            try { Thread.sleep(200) } catch (_: InterruptedException) { break }
          }
          handler.post {
            setTool(status.second)
            if (menu != null) refreshMenu()
          }
        }.start()
      }
    }
    toolObserver = observer
    observer.startWatching()
  }

  /** 显示/隐藏「AI 正在使用的工具」标签，带动画与窗口重排。 */
  private fun setTool(tool: String?) {
    val name = tool?.takeIf { it.isNotBlank() }
    currentTool = name
    val pill = ball?.findViewById<TextView>(R.id.fbTool) ?: return
    toolAnimator?.cancel()
    if (name == null) {
      // 工具刚结束：先取消任何未执行的隐藏，1 秒后再淡出消失，方便看清刚用的工具；
      // 期间若有新工具到来，setTool(非 null) 会取消这个挂起的隐藏并立即显示。
      pendingHideRunnable?.let { handler.removeCallbacks(it) }
      if (pill.visibility == View.GONE) return
      val runnable = Runnable {
        pendingHideRunnable = null
        if (currentTool == null && pill.visibility != View.GONE) {
          pillVisible = false
          toolAnimator = ValueAnimator.ofFloat(1f, 0f).apply {
            duration = 150
            addUpdateListener { pill.alpha = it.animatedValue as Float }
            addListener(object : android.animation.AnimatorListenerAdapter() {
              override fun onAnimationEnd(animation: android.animation.Animator) {
                if (currentTool == null) {
                  pill.visibility = View.GONE
                  pill.alpha = 1f
                  applyBallLayout()
                }
              }
            })
            start()
          }
        }
      }
      pendingHideRunnable = runnable
      handler.postDelayed(runnable, TOOL_HIDE_DELAY_MS)
      return
    }
    // 新工具到来：取消挂起的隐藏，立即显示新工具名
    pendingHideRunnable?.let { handler.removeCallbacks(it) }
    pendingHideRunnable = null
    pill.text = name
    if (pill.visibility != View.VISIBLE) {
      pill.alpha = 0f
      pill.visibility = View.VISIBLE
      pillVisible = true
      applyBallLayout()
      toolAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 180
        addUpdateListener { pill.alpha = it.animatedValue as Float }
        start()
      }
    } else {
      pill.alpha = 1f
      pillVisible = true
    }
  }

  // ── 长按状态面板 ──────────────────────────────────────────────
  private fun showMenu() {
    longPressTriggered = true
    if (menu != null) return
    val wm = wm ?: return
    // 全屏透明遮罩：接管菜单外所有点击（点击空白处即关闭，模态行为）。
    // 先加遮罩再加面板，面板 z 序在遮罩之上。
    val scrim = View(this)
    scrim.setOnClickListener { hideMenu() }
    val sp = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START }
    val view = LayoutInflater.from(this).inflate(R.layout.floatball_menu, null)
    view.findViewById<View>(R.id.fbMenuOpen).setOnClickListener { openApp(); hideMenu() }
    view.findViewById<View>(R.id.fbMenuClose).setOnClickListener { stopSelf() }
    view.findViewById<View>(R.id.fbMenuTitle).setOnClickListener { hideMenu() }
    val p = WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      val bw = dp(BALL_DP)
      val mw = dp(190)
      var x = ballX + bw + dp(8)
      val sw = resources.displayMetrics.widthPixels
      if (x + mw > sw - dp(8)) x = (ballX - mw - dp(8)).coerceAtLeast(dp(8))
      this.x = x
      this.y = (ballY - dp(30)).coerceIn(dp(8), resources.displayMetrics.heightPixels - dp(220))
    }
    menuScrim = scrim
    wm.addView(scrim, sp)
    menu = view
    wm.addView(view, p)
    refreshMenu()
  }

  private fun hideMenu() {
    try { menu?.let { wm?.removeView(it) } } catch (_: Exception) {}
    try { menuScrim?.let { wm?.removeView(it) } } catch (_: Exception) {}
    menu = null
    menuScrim = null
  }

  private fun refreshMenu() {
    val st = menu?.findViewById<TextView>(R.id.fbMenuStatus) ?: return
    val dsh = lastStatus == true
    val pc = PhoneAccessibilityService.isEnabled(this)
    st.text = buildString {
      append("dsh 服务：").append(if (dsh) "运行中" else "未运行").append('\n')
      append("手机控制：").append(if (pc) "已开启" else "未开启")
      currentTool?.let { append('\n').append("当前工具：").append(it) }
    }
  }
}
