package com.dshmobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * 手机控制核心：无障碍服务。
 *
 * 通过读取当前窗口的 UI 层级（rootInActiveWindow）把可交互元素 dump 成 JSON，
 * 并支持点击（文本/坐标）、长按、双击、滑动、输入文本、滚动、全局按键
 * （返回/主页/最近/通知栏/电源）、打开应用、查找元素等操作。
 * 由 dsh-tool-phone 插件经本地 HTTP 服务调用，让 AI 能操控手机。
 *
 * 用户需在系统「无障碍」设置中为 DeepSeek Harness 开启该服务；未开启时
 * 所有操作返回明确错误并引导开启。
 */
class PhoneAccessibilityService : AccessibilityService() {

  companion object {
    private const val TAG = "PhoneCtrl"

    @Volatile
    var instance: PhoneAccessibilityService? = null
      private set

    /** 本应用无障碍服务的系统标识（Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES 中的条目）。 */
    const val SERVICE_ID = "com.dshmobile/.PhoneAccessibilityService"

    /**
     * 服务是否已启用。优先看服务实例是否存活；否则用 AccessibilityManager 的
     * getEnabledAccessibilityServiceList() 查询（官方 API，不受系统设置字符串
     * 格式差异影响，比读 Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES 可靠）。
     */
    fun isEnabled(context: Context? = null): Boolean {
      if (instance != null) return true
      val ctx = context ?: instance?.applicationContext ?: return false
      return runCatching {
        val am = ctx.getSystemService(Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager
        am.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
          .any { info ->
            val si = info.resolveInfo?.serviceInfo ?: return@any false
            // serviceInfo.name 是完整类名（com.dshmobile.PhoneAccessibilityService），
            // 不能和 simpleName 比较（永远 false）。
            si.packageName == ctx.packageName && si.name == PhoneAccessibilityService::class.java.name
          }
      }.getOrDefault(false)
    }
  }

  private val mainHandler = Handler(Looper.getMainLooper())

  /** 当前活动窗口的根节点；每次窗口变化时替换。 */
  @Volatile private var root: AccessibilityNodeInfo? = null

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    // 兜底启动本地 HTTP 服务（正常情况下已由后台前台服务启动）
    PhoneControlHttp.start(this)
    Log.d(TAG, "accessibility service connected")
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event == null) return
    when (event.eventType) {
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
        val newRoot = rootInActiveWindow
        if (newRoot != null) {
          val old = root
          root = newRoot
          try { old?.recycle() } catch (_: Exception) {}
        }
      }
    }
  }

  override fun onInterrupt() {}

  override fun onUnbind(intent: Intent?): Boolean {
    instance = null
    try { root?.recycle() } catch (_: Exception) {}
    root = null
    return super.onUnbind(intent)
  }

  // ── 在主线程执行（accessibility 节点操作/手势需主线程 Looper） ───────────────

  private fun <T> onMain(block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val latch = CountDownLatch(1)
    val holder = AtomicReference<T>()
    val error = AtomicReference<Throwable>()
    mainHandler.post {
      try {
        holder.set(block())
      } catch (t: Throwable) {
        error.set(t)
      } finally {
        latch.countDown()
      }
    }
    latch.await(5, TimeUnit.SECONDS)
    error.get()?.let { throw it }
    return holder.get()
  }

  // ── 屏幕 dump ───────────────────────────────────────────────────────────────

  /** 主动刷新当前活动窗口根节点（读屏前调用，保证拿到最新 UI 层级）。 */
  private fun refreshRoot(): AccessibilityNodeInfo? {
    return onMain {
      runCatching {
        val newRoot = rootInActiveWindow
        if (newRoot != null) {
          val old = root
          root = newRoot
          try { old?.recycle() } catch (_: Exception) {}
        }
        newRoot
      }.getOrNull()
    }
  }

  /** 把当前窗口可交互元素 dump 成 JSON 数组。 */
  fun dumpScreen(): JSONObject {
    var node = root
    // 读屏前强制刷新：服务刚连接或界面刚切换时 root 可能为空/过期
    if (node == null || !node.isVisibleToUser) {
      node = refreshRoot()
    }
    if (node == null) {
      return JSONObject().put("error", "无法读取当前屏幕：请确认屏幕上有一个已打开的界面，且无障碍服务已开启")
    }
    return onMain {
      val arr = JSONArray()
      walk(node, arr, 0)
      val out = JSONObject()
      out.put("elements", arr)
      val bounds = Rect()
      node.getBoundsInScreen(bounds)
      out.put("screen", JSONObject().put("left", bounds.left).put("top", bounds.top)
        .put("right", bounds.right).put("bottom", bounds.bottom))
      out
    }
  }

  private fun walk(node: AccessibilityNodeInfo, arr: JSONArray, depth: Int) {
    if (depth > 50) return
    if (node.isVisibleToUser) {
      val el = JSONObject()
      val text = node.text?.toString()
      val desc = node.contentDescription?.toString()
      val cls = node.className?.toString()
      val clickable = node.isClickable
      val longClickable = node.isLongClickable
      val scrollable = node.isScrollable
      val editable = node.isEditable
      val checked = node.isChecked
      // 只保留对 AI 有用的可交互/有内容节点，减少噪音
      if (text != null || desc != null || clickable || longClickable || scrollable || editable) {
        if (text != null) el.put("text", text)
        if (desc != null) el.put("desc", desc)
        if (cls != null) el.put("class", cls)
        if (clickable) el.put("clickable", true)
        if (longClickable) el.put("longClickable", true)
        if (scrollable) el.put("scrollable", true)
        if (editable) el.put("editable", true)
        if (checked) el.put("checked", true)
        val b = Rect()
        node.getBoundsInScreen(b)
        el.put("bounds", JSONObject().put("l", b.left).put("t", b.top)
          .put("r", b.right).put("b", b.bottom))
        arr.put(el)
      }
    }
    for (i in 0 until node.childCount) {
      val child = node.getChild(i) ?: continue
      walk(child, arr, depth + 1)
      try { child.recycle() } catch (_: Exception) {}
    }
  }

  // ── 元素查找 ───────────────────────────────────────────────────────────────

  private fun findNode(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
    val node = root ?: return null
    val queue = ArrayDeque<AccessibilityNodeInfo>()
    queue.add(node)
    while (queue.isNotEmpty()) {
      val cur = queue.removeFirst()
      if (predicate(cur)) return cur
      for (i in 0 until cur.childCount) {
        val child = cur.getChild(i) ?: continue
        queue.add(child)
      }
    }
    return null
  }

  private fun clickableNodeContaining(query: String): AccessibilityNodeInfo? {
    val q = query.trim().lowercase()
    return findNode { n ->
      n.isVisibleToUser && (n.isClickable || n.isLongClickable) &&
        (n.text?.toString()?.lowercase()?.contains(q) == true ||
          n.contentDescription?.toString()?.lowercase()?.contains(q) == true)
    }
  }

  private fun findEditableNode(): AccessibilityNodeInfo? {
    val focused = findNode { n -> n.isVisibleToUser && n.isFocused && n.isEditable }
    if (focused != null) return focused
    return findNode { n -> n.isVisibleToUser && n.isEditable && n.isEnabled }
  }

  // ── 操作 ───────────────────────────────────────────────────────────────────

  /** 点击坐标。 */
  fun tap(x: Int, y: Int): JSONObject {
    val result = onMain {
      val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
      val gesture = GestureDescription.Builder()
        .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
        .build()
      dispatchGesture(gesture, null, null)
    }
    return if (result) JSONObject().put("ok", true).put("x", x).put("y", y)
    else JSONObject().put("ok", false).put("error", "手势派发失败（无障碍服务可能未运行）")
  }

  /** 按文本/描述匹配可点击元素并点击。 */
  fun tapText(query: String): JSONObject {
    val node = onMain { clickableNodeContaining(query) }
    if (node == null) {
      return JSONObject().put("ok", false).put("error", "未找到包含「$query」的可点击元素")
    }
    val ok = onMain {
      try { node.performAction(AccessibilityNodeInfo.ACTION_CLICK) } catch (_: Exception) { false }
    }
    try { node.recycle() } catch (_: Exception) {}
    return if (ok) JSONObject().put("ok", true).put("matched", query)
    else JSONObject().put("ok", false).put("error", "点击失败")
  }

  /** 长按坐标（按住不放 650ms）。 */
  fun longPress(x: Int, y: Int): JSONObject {
    val result = onMain {
      val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
      val gesture = GestureDescription.Builder()
        .addStroke(GestureDescription.StrokeDescription(path, 0, 650))
        .build()
      dispatchGesture(gesture, null, null)
    }
    return if (result) JSONObject().put("ok", true).put("x", x).put("y", y).put("longPress", true)
    else JSONObject().put("ok", false).put("error", "长按手势派发失败")
  }

  /** 双击坐标（两次快速点击，间隔 80ms）。 */
  fun doubleTap(x: Int, y: Int): JSONObject {
    val result = onMain {
      val p1 = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
      val p2 = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
      val g1 = GestureDescription.StrokeDescription(p1, 0, 60)
      // 双击：第一个手势在 300ms 处结束，第二个从 400ms 开始
      val g2 = GestureDescription.StrokeDescription(p2, 380, 60)
      GestureDescription.Builder()
        .addStroke(g1)
        .addStroke(g2)
        .build()
    }
    val dispatched = onMain { dispatchGesture(result, null, null) }
    return if (dispatched) JSONObject().put("ok", true).put("x", x).put("y", y).put("doubleTap", true)
    else JSONObject().put("ok", false).put("error", "双击手势派发失败")
  }

  /** 在屏幕上查找包含指定文本的元素，返回其中心坐标。 */
  fun find(query: String): JSONObject {
    val q = query.trim().lowercase()
    val node = onMain {
      findNode { n ->
        n.isVisibleToUser &&
          (n.text?.toString()?.lowercase()?.contains(q) == true ||
            n.contentDescription?.toString()?.lowercase()?.contains(q) == true)
      }
    }
    if (node == null) {
      return JSONObject().put("ok", false).put("found", false).put("error", "屏幕上未找到包含「$query」的内容")
    }
    val bounds = Rect()
    onMain { node.getBoundsInScreen(bounds) }
    try { node.recycle() } catch (_: Exception) {}
    val cx = bounds.centerX()
    val cy = bounds.centerY()
    return JSONObject().put("ok", true).put("found", true).put("text", query)
      .put("x", cx).put("y", cy)
      .put("bounds", JSONObject().put("l", bounds.left).put("t", bounds.top)
        .put("r", bounds.right).put("b", bounds.bottom))
  }

  /** 展开通知栏（下拉）。 */
  fun openNotifications(): JSONObject {
    val ok = onMain { performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS) }
    return if (ok) JSONObject().put("ok", true).put("action", "notifications")
    else JSONObject().put("ok", false).put("error", "展开通知栏失败")
  }

  /** 返回桌面。 */
  fun backToHome(): JSONObject {
    val ok = onMain { performGlobalAction(GLOBAL_ACTION_HOME) }
    return if (ok) JSONObject().put("ok", true).put("action", "home")
    else JSONObject().put("ok", false).put("error", "返回桌面失败")
  }

  /** 滑动。 */
  fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Int): JSONObject {
    val dur = if (duration in 50..5000) duration else 300
    val result = onMain {
      val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }
      val gesture = GestureDescription.Builder()
        .addStroke(GestureDescription.StrokeDescription(path, 0, dur.toLong()))
        .build()
      dispatchGesture(gesture, null, null)
    }
    return if (result) JSONObject().put("ok", true).put("swipe", "$x1,$y1 → $x2,$y2")
    else JSONObject().put("ok", false).put("error", "手势派发失败")
  }

  /** 输入文本到当前聚焦的可编辑元素。 */
  fun typeText(text: String): JSONObject {
    val node = onMain { findEditableNode() }
    if (node == null) {
      return JSONObject().put("ok", false).put("error", "当前没有可输入的输入框（请先点击输入框聚焦）")
    }
    val args = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }
    val ok = onMain {
      try { node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) } catch (_: Exception) { false }
    }
    try { node.recycle() } catch (_: Exception) {}
    return if (ok) JSONObject().put("ok", true).put("typed", text)
    else JSONObject().put("ok", false).put("error", "输入失败")
  }

  /** 滚动：优先滚动可滚动元素（上下），左右用滑动手势。 */
  fun scroll(direction: String): JSONObject {
    val dir = direction.lowercase()
    // 上下：滚动可滚动元素；左右：API 37 已移除 ACTION_SCROLL_LEFT/RIGHT，直接滑动手势
    val node = if (dir == "up" || dir == "down") {
      onMain { findNode { n -> n.isVisibleToUser && n.isScrollable } }
    } else null
    if (node != null) {
      val action = if (dir == "up") AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
      else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
      val ok = onMain {
        try { node.performAction(action) } catch (_: Exception) { false }
      }
      try { node.recycle() } catch (_: Exception) {}
      if (ok) return JSONObject().put("ok", true).put("direction", direction)
    }
    // 兜底：用滑动手势模拟
    val bounds = Rect()
    root?.let { onMain { it.getBoundsInScreen(bounds) } }
    if (bounds.isEmpty) return JSONObject().put("ok", false).put("error", "无法滚动")
    val w = bounds.width().toFloat()
    val h = bounds.height().toFloat()
    val (x1, y1, x2, y2) = when (dir) {
      "up" -> arrayOf(w / 2, h * 0.7f, w / 2, h * 0.3f)
      "down" -> arrayOf(w / 2, h * 0.3f, w / 2, h * 0.7f)
      "left" -> arrayOf(w * 0.8f, h / 2, w * 0.2f, h / 2)
      "right" -> arrayOf(w * 0.2f, h / 2, w * 0.8f, h / 2)
      else -> return JSONObject().put("ok", false).put("error", "未知方向：$direction")
    }
    val result = onMain {
      val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
      val gesture = GestureDescription.Builder()
        .addStroke(GestureDescription.StrokeDescription(path, 0, 300))
        .build()
      dispatchGesture(gesture, null, null)
    }
    return if (result) JSONObject().put("ok", true).put("direction", direction).put("gesture", true)
    else JSONObject().put("ok", false).put("error", "滚动失败")
  }

  /** 全局按键：返回 / 主页 / 最近任务；enter 尝试点击提交类按钮。 */
  fun pressKey(key: String): JSONObject {
    val k = key.lowercase()
    val global = when (k) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recent", "recents" -> GLOBAL_ACTION_RECENTS
      else -> null
    }
    if (global != null) {
      val ok = onMain { performGlobalAction(global) }
      return if (ok) JSONObject().put("ok", true).put("key", k)
      else JSONObject().put("ok", false).put("error", "按键执行失败")
    }
    if (k == "enter") {
      // 点击聚焦元素（如发送/搜索按钮）；否则匹配常见提交文案
      val focused = onMain { findNode { n -> n.isVisibleToUser && n.isFocused && n.isClickable } }
      if (focused != null) {
        val ok = onMain {
          try { focused.performAction(AccessibilityNodeInfo.ACTION_CLICK) } catch (_: Exception) { false }
        }
        try { focused.recycle() } catch (_: Exception) {}
        if (ok) return JSONObject().put("ok", true).put("key", "enter")
      }
      val submitLabels = listOf("搜索", "发送", "确定", "登录", "下一步", "完成", "打开", "Go", "Search", "Send", "Enter", "OK")
      for (label in submitLabels) {
        val target = onMain { clickableNodeContaining(label) }
        if (target != null) {
          val ok = onMain {
            try { target.performAction(AccessibilityNodeInfo.ACTION_CLICK) } catch (_: Exception) { false }
          }
          try { target.recycle() } catch (_: Exception) {}
          if (ok) return JSONObject().put("ok", true).put("key", "enter").put("matched", label)
        }
      }
      return JSONObject().put("ok", false).put("error", "未找到可提交的按钮")
    }
    return JSONObject().put("ok", false).put("error", "不支持的按键：$key（支持 back/home/recent/enter）")
  }

  /** 打开指定包名的应用。 */
  fun openApp(pkg: String): JSONObject {
    val intent = onMain { packageManager.getLaunchIntentForPackage(pkg) }
    if (intent == null) {
      return JSONObject().put("ok", false).put("error", "未找到应用：$pkg")
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    onMain {
      try {
        startActivity(intent)
        true
      } catch (_: Exception) { false }
    }.let { started ->
      return if (started) JSONObject().put("ok", true).put("package", pkg)
      else JSONObject().put("ok", false).put("error", "启动应用失败：$pkg")
    }
  }
}
