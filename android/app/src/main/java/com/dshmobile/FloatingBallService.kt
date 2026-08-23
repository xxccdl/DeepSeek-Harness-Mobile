package com.dshmobile

import android.animation.ValueAnimator
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
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
    private const val LONG_PRESS_MS = 450L
    private const val BALL_DP = 56
    // 「AI 正在使用的工具」标签尺寸
    private const val PILL_DP = 106
    private const val PILL_GAP_DP = 6
    // 当前工具状态文件（dsh-mobile-bridge 插件写入 <files>/status/current-tool.json）
    private const val TOOL_REL_PATH = "status/current-tool.json"

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
  private val handler = Handler(Looper.getMainLooper())
  private var pollThread: Thread? = null

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

  private val longPressRunnable = Runnable { showMenu() }

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
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    pollThread?.interrupt()
    pollThread = null
    handler.removeCallbacks(longPressRunnable)
    try { ball?.let { wm?.removeView(it) } } catch (_: Exception) {}
    try { menu?.let { wm?.removeView(it) } } catch (_: Exception) {}
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
    ballX = ballParams.x
    ballY = ballParams.y
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
          ballX = (downBallX + dx).toInt()
          ballY = (downBallY + dy).toInt()
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
    anim.start()
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

  private fun startStatusPolling() {
    pollThread?.interrupt()
    val t = Thread {
      while (running) {
        val ok = probeDsh()
        val tool = readCurrentTool()
        handler.post {
          setStatus(ok)
          setTool(tool)
        }
        try { Thread.sleep(POLL_MS) } catch (_: InterruptedException) { break }
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

  /** 读取 dsh-mobile-bridge 插件写入的「当前 AI 工具」状态。 */
  private fun readCurrentTool(): String? {
    return try {
      val f = File(filesDir, TOOL_REL_PATH)
      if (!f.exists()) return null
      val json = JSONObject(f.readText())
      val tool = json.optString("tool", "").trim()
      if (tool.isEmpty()) null else tool
    } catch (_: Exception) {
      null
    }
  }

  /** 显示/隐藏「AI 正在使用的工具」标签，带动画与窗口重排。 */
  private fun setTool(tool: String?) {
    val name = tool?.takeIf { it.isNotBlank() }
    currentTool = name
    val pill = ball?.findViewById<TextView>(R.id.fbTool) ?: return
    toolAnimator?.cancel()
    if (name == null) {
      if (pill.visibility != View.GONE) {
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
      return
    }
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
    menu = view
    wm.addView(view, p)
    refreshMenu()
  }

  private fun hideMenu() {
    try { menu?.let { wm?.removeView(it) } } catch (_: Exception) {}
    menu = null
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
