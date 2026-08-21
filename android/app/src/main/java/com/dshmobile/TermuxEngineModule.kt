package com.dshmobile

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.FileObserver
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStreamReader
import java.nio.file.Files
import java.nio.file.Paths
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

/**
 * 内嵌 Termux 引擎：解压 bootstrap、初始化环境、启动/停止 dsh 服务。
 * 通过 ProcessBuilder 运行内嵌的 bash/node（Termux 前缀替换由 libtermux-exec.so 处理）。
 */
class TermuxEngineModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule() {

  override fun getName(): String = "TermuxEngine"

  private val filesDir: File get() = reactContext.filesDir
  private val prefixDir: File get() = File(filesDir, "usr")
  private val homeDir: File get() = File(filesDir, "home")

  @Volatile private var dshProcess: Process? = null
  @Volatile private var initProcess: Process? = null

  /** 运行内嵌二进制所需的 Termux 环境变量（termux-exec 修复 shebang 前缀）。 */
  private fun termuxEnv(): Map<String, String> {
    val prefix = prefixDir.absolutePath
    // 路径重映射库：apt/dpkg/proot-distro 等读取编译期硬编码的
    // /data/data/com.termux/files，经 LD_PRELOAD 拦截重写到真实前缀。
    // 库缺失时不加入 LD_PRELOAD，避免进程因 preload 失败无法启动。
    val remapLib = File(prefixDir, "lib/libdsh-pathremap.so")
    val preload = if (remapLib.exists()) {
      "${remapLib.absolutePath}:$prefix/lib/libtermux-exec.so"
    } else {
      "$prefix/lib/libtermux-exec.so"
    }
    return mapOf(
      "PREFIX" to prefix,
      "HOME" to homeDir.absolutePath,
      "TMPDIR" to File(filesDir, "tmp").absolutePath,
      "LD_LIBRARY_PATH" to "$prefix/lib",
      "LD_PRELOAD" to preload,
      "DSH_REMAP_PREFIX" to filesDir.absolutePath,
      "PATH" to "$prefix/bin:$prefix/bin/applets:/system/bin:/system/xbin",
      "TERMUX_VERSION" to "0.118.0",
      "TERMUX_APK_RELEASE" to "F-DROID",
      // proot-distro 读取这些变量定位真实前缀（它默认硬编码 /data/data/com.termux）
      "TERMUX__PREFIX" to prefix,
      "TERMUX__HOME" to homeDir.absolutePath,
      "TERMUX_APP__PACKAGE_NAME" to reactContext.packageName,
      // proot 硬编码的 loader 与 tmp 路径，覆盖到真实前缀（否则在其他应用 /data/data 下 EACCES）
      "PROOT_LOADER" to "$prefix/libexec/proot/loader",
      "PROOT_LOADER_32" to "$prefix/libexec/proot/loader32",
      "PROOT_TMP_DIR" to File(filesDir, "tmp").absolutePath,
      // node 编译期默认 /data/data/com.termux 路径，用 OPENSSL_CONF 指向实际前缀
      "OPENSSL_CONF" to "$prefix/etc/tls/openssl.cnf",
      // 手机版：AI 的 bash 工具改在 proot-distro Debian 容器内执行
      "DSH_MOBILE_PROOT" to "1",
      // 宿主 files 目录（proot-distro 内需要把工作区 bind 进来，AI 才能访问项目文件）
      "DSH_MOBILE_FILES_DIR" to filesDir.absolutePath,
      // 走 danger-full-access：dsh 的 workspace-write 沙箱会限制 /usr 等写入，
      // 阻碍 AI 在 Debian 里 apt install；Android 应用沙箱 + proot 已提供隔离，
      // 且 bash-sandbox 仅在 danger-full-access 分支才复用 bash-local 的 proot 包装。
      "DSH_PERMISSION_MODE" to "danger-full-access",
      "DSH_TELEMETRY_DISABLED" to "1",
      "DSH_BUNDLE" to File(filesDir, "dsh").absolutePath,
      "DSH_HOME" to File(filesDir, "dsh-home").absolutePath,
    )
  }

  private fun emitProgress(message: String, pct: Int) {
    Log.d("TermuxEngine", message)
    try {
      val params: WritableMap = Arguments.createMap()
      params.putString("message", message)
      params.putInt("progress", pct)
      reactContext.emitDeviceEvent("TermuxEngine/progress", params)
    } catch (e: Exception) {
      // 上下文已失效（Activity 销毁 / 模块 invalidate）：进度事件不阻断流程，
      // 否则流式消费线程未捕获异常会导致整个 App 崩溃
      Log.w("TermuxEngine", "emit progress ignored: ${e.message}")
    }
  }

  // ── 状态查询 ────────────────────────────────────────────────────────────────

  @ReactMethod
  fun isReady(promise: Promise) {
    promise.resolve(File(prefixDir, "bin/bash").exists() && File(prefixDir, "bin/node").exists())
  }

  @ReactMethod
  fun isRunning(promise: Promise) {
    promise.resolve(dshProcess?.isAlive == true)
  }

  @ReactMethod
  fun prefixPath(promise: Promise) {
    promise.resolve(prefixDir.absolutePath)
  }

  // ── 解压 bootstrap ───────────────────────────────────────────────────────────

  /** 串行化解压锁：并发调用（如超时后用户点重试）时后到的线程等待前一个完成。 */
  private val extractLock = Any()

  @ReactMethod
  fun extractBootstrap(promise: Promise) {
    Thread {
      try {
        // 后到的线程等前一个解压完成后，会命中幂等快速路径立即返回，避免并发写坏文件
        synchronized(extractLock) {
          extractBootstrapSync()
        }
        promise.resolve(true)
      } catch (e: Exception) {
        promise.reject("extract_failed", e.message ?: "extract failed")
      }
    }.start()
  }

  private fun extractBootstrapSync() {
    prefixDir.mkdirs()
    homeDir.mkdirs()
    File(filesDir, "tmp").mkdirs()
    // 每次启动都部署路径重映射库（22KB，覆盖写保证与 APK 同步）：
    // apt/dpkg/proot-distro 读取编译期硬编码的 /data/data/com.termux/files，
    // 经 LD_PRELOAD 拦截 libc 文件 API 重写到真实前缀（termuxEnv 注入）。
    try {
      val remapDest = File(prefixDir, "lib/libdsh-pathremap.so")
      reactContext.assets.open("termux/libdsh-pathremap.so").use { input ->
        remapDest.parentFile?.mkdirs()
        FileOutputStream(remapDest).use { out -> input.copyTo(out, 64 * 1024) }
      }
    } catch (e: Exception) {
      Log.w("TermuxEngine", "remap lib deploy failed: ${e.message}")
    }
    val doneMarker = File(prefixDir, ".bootstrap-done")
    // 以 bootstrap zip 资源大小作为版本标识：已解压且版本一致则跳过全部扫描
    // （飞速启动关键：zip 扫描 + 符号链接 + 全树可执行位恢复都很耗时）
    val assetLen = try {
      reactContext.assets.openFd("termux/bootstrap-aarch64.zip").length
    } catch (_: Exception) { -1L }
    val doneLen0 = runCatching { doneMarker.readText().trim().toLong() }.getOrNull() ?: -1L
    // 旧版标记为 "ok"（非数字）：视为已解压完成，仅把标记迁移为数字大小，
    // 避免升级后一次性重新解压整个环境
    var doneLen = doneLen0
    if (doneMarker.exists() && doneLen < 0 && assetLen > 0) {
      doneLen = assetLen
      doneMarker.writeText(assetLen.toString())
    }
    if (doneMarker.exists() && doneLen == assetLen) {
      // 幂等补齐 dsh bundle（自带大小校验，通常直接跳过）
      extractDshBundle()
      return
    }
    val fresh = !doneMarker.exists()

    val symlinks = mutableListOf<Pair<String, String>>()
    val input = reactContext.assets.open("termux/bootstrap-aarch64.zip")
    ZipInputStream(input).use { zis ->
      var entry: ZipEntry? = zis.nextEntry
      while (entry != null) {
        val name = entry.name
        if (!entry.isDirectory) {
          if (name == "SYMLINKS.txt") {
            // 按条目精确读到 EOF，避免 Reader 跨条目预读破坏 zip 流
            val bos = java.io.ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (true) {
              val n = zis.read(buf)
              if (n < 0) break
              bos.write(buf, 0, n)
            }
            String(bos.toByteArray(), Charsets.UTF_8).lineSequence().forEach { line ->
              val idx = line.indexOf('←') // ←
              // 格式为 "target←link"：右侧是符号链接路径，左侧是目标
              if (idx > 0) symlinks.add(line.substring(idx + 1) to line.substring(0, idx))
            }
          } else if (fresh) {
            val target = File(prefixDir, name)
            target.parentFile?.mkdirs()
            FileOutputStream(target).use { out -> zis.copyTo(out, 64 * 1024) }
            // zip 不保留 unix 权限；bin 下统一可执行
            if (name.startsWith("bin/")) target.setExecutable(true, false)
          }
        }
        zis.closeEntry()
        entry = zis.nextEntry
      }
    }

    // 创建符号链接（SYMLINKS.txt：target←link），失败则拷贝目标兜底；
    // 幂等执行：旧版本解压过但符号链接缺失时也能补齐
    for ((link, rawTarget) in symlinks) {
      val linkFile = File(prefixDir, link.removePrefix("./"))
      val resolved = resolveSymlinkTarget(rawTarget, linkFile) ?: continue
      linkFile.parentFile?.mkdirs()
      try {
        linkFile.delete()
        Files.createSymbolicLink(linkFile.toPath(), Paths.get(resolved))
      } catch (e: Exception) {
        val source = File(resolved)
        if (source.exists()) {
          try {
            source.copyTo(linkFile, overwrite = true)
            linkFile.setExecutable(true, false)
          } catch (_: Exception) {}
        }
      }
    }
    // zip / 拷贝不保留权限：统一恢复可执行位
    makeExecutableTree(prefixDir)
    if (assetLen > 0) doneMarker.writeText(assetLen.toString()) else doneMarker.writeText("ok")
    // 解压内嵌 dsh bundle（模块/插件/注册配置），幂等
    extractDshBundle()
  }

  /** 为 bin/ libexec/ sbin/ 下的文件恢复可执行位（解压与拷贝均不保留权限）。 */
  private fun makeExecutableTree(root: File) {
    root.walkTopDown().forEach { f ->
      if (f.isFile) {
        val p = f.absolutePath.replace('\\', '/')
        if (p.contains("/bin/") || p.contains("/libexec/") || p.contains("/sbin/")) {
          f.setExecutable(true, false)
        }
      }
    }
  }

  /** 复制 assets/dsh 下的内嵌引擎到 <files>/dsh（dsh-bundle.dat、node-runtime.dat、plugins/、patch）。
   *  幂等：dsh-bundle.dat 已存在且大小一致则跳过，避免每次启动重复拷贝。 */
  private fun extractDshBundle() {
    val dest = File(filesDir, "dsh")
    val bundle = File(dest, "dsh-bundle.dat")
    val marker = File(dest, ".bundle-ok")
    val assetSize = try { reactContext.assets.openFd("dsh/dsh-bundle.dat").length } catch (_: Exception) { -1L }
    // proot-distro.dat 也必须就位：否则升级新增该文件时，因 dsh-bundle.dat 未变而漏拷到 <files>/dsh，
    // 导致 init-termux.sh 找不到 proot-distro.dat（AI bash 无法进入 Debian 环境）。
    val prootDat = File(dest, "proot-distro.dat")
    if (bundle.exists() && bundle.length() == assetSize && marker.exists() && prootDat.exists()) return
    copyAssetRecursive("dsh", dest)
    marker.writeText("ok")
  }

  /** 递归复制 assets 资源：先尝试作为文件打开，失败则视为目录。 */
  private fun copyAssetRecursive(assetPath: String, target: File) {
    try {
      reactContext.assets.open(assetPath).use { input ->
        target.parentFile?.mkdirs()
        FileOutputStream(target).use { out -> input.copyTo(out, 64 * 1024) }
      }
      return
    } catch (_: IOException) {
      // 不是文件，按目录处理
    }
    val entries = reactContext.assets.list(assetPath) ?: return
    target.mkdirs()
    for (entry in entries) {
      copyAssetRecursive("$assetPath/$entry", File(target, entry))
    }
  }

  /** 将 bootstrap 硬编码的 /data/data/com.termux/files/usr 前缀替换为当前 App 前缀。
   *  相对目标基于 link 所在目录解析（SYMLINKS.txt 的 target 为相对 link 目录的路径）。 */
  private fun resolveSymlinkTarget(raw: String, linkFile: File): String? {
    val legacy = "/data/data/com.termux/files/usr"
    return when {
      raw.startsWith(legacy) -> prefixDir.absolutePath + raw.substring(legacy.length)
      raw.startsWith("/") -> prefixDir.absolutePath + raw
      else -> File(linkFile.parentFile ?: prefixDir, raw).canonicalPath
    }
  }

  // ── 环境是否已初始化完成（免跑 bash 脚本飞速启动） ────────────────────────

  @ReactMethod
  fun isInitialized(promise: Promise) {
    val envDone = File(filesDir, "dsh-home/.env-done")
    val dshBin = File(prefixDir, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")
    // bundle 变更检测：<files>/dsh/dsh-bundle.dat 与已解压到 $PREFIX/lib 的记录不一致
    // （APK 升级后新引擎/补丁）时需重新跑 init-termux.sh，否则 bash-local 等补丁不生效。
    val bundleDat = File(filesDir, "dsh/dsh-bundle.dat")
    val bundleSizeMark = File(prefixDir, "lib/.bundle-size")
    val bundleFresh = runCatching {
      bundleDat.exists() && bundleSizeMark.exists() &&
        bundleSizeMark.readText().trim().toLong() == bundleDat.length()
    }.getOrDefault(false)
    // proot-distro 运行时也需就位（新装机升级补装 Debian 环境）
    val prootOk = File(prefixDir, "bin/proot").exists() && File(prefixDir, "bin/python3.14").exists() &&
      File(prefixDir, "lib/python3.14/site-packages/proot_distro/cli.py").exists()
    promise.resolve(envDone.exists() && dshBin.exists() && bundleFresh && prootOk)
  }

  // ── 初始化环境（apt 装 node/dsh）────────────────────────────────────────────

  /** 初始化互斥锁：超时后用户点重试时，等待进行中的初始化完成并复用其结果。 */
  private val initLock = Any()

  @ReactMethod
  fun initialize(promise: Promise) {
    Thread {
      try {
        synchronized(initLock) {
          val existing = initProcess
          if (existing?.isAlive == true) {
            // 已有初始化进行中：等待其结束并复用结果，而非报 "busy" 让重试失败
            val code = existing.waitFor()
            if (code == 0) {
              emitProgress("环境初始化完成", 100)
              promise.resolve(true)
            } else {
              promise.reject("init_failed", "初始化失败 (exit $code)，请查看日志")
            }
            return@Thread
          }
          val bashBin = File(prefixDir, "bin/bash")
          Log.d("TermuxEngine", "initialize: bash=$bashBin exists=${bashBin.exists()} exec=${bashBin.canExecute()}")
          val script = "bash ${initScriptPath()}"
          val pb = ProcessBuilder(bashBin.absolutePath, "-c", script)
          pb.environment().putAll(termuxEnv())
          val proc = pb.start()
          initProcess = proc
          // 流式输出进度
          val reader = proc.inputStream.bufferedReader()
          val errReader = proc.errorStream.bufferedReader()
          val sink = Thread {
            reader.forEachLine { line ->
              Log.d("TermuxEngine", "out: $line")
              emitProgress(line, -1)
            }
          }
          val errSink = Thread {
            errReader.forEachLine { line ->
              Log.e("TermuxEngine", "err: $line")
              emitProgress(line, -1)
            }
          }
          sink.start()
          errSink.start()
          emitProgress("正在初始化环境…", 2)
          val code = proc.waitFor()
          sink.join()
          errSink.join()
          Log.d("TermuxEngine", "initialize exit code = $code")
          if (code == 0) {
            emitProgress("环境初始化完成", 100)
            promise.resolve(true)
          } else {
            promise.reject("init_failed", "初始化失败 (exit $code)，请查看日志")
          }
        }
      } catch (e: Exception) {
        Log.e("TermuxEngine", "initialize exception", e)
        promise.reject("init_error", e.message ?: "init error")
      }
    }.start()
  }

  /** 把 assets 里的 init 脚本复制到 files 下（每次覆盖，保证与 APK 同步）。 */
  private fun initScriptPath(): String {
    val dest = File(filesDir, "init-termux.sh")
    reactContext.assets.open("termux/init-termux.sh").use { input ->
      FileOutputStream(dest).use { out -> input.copyTo(out) }
    }
    return dest.absolutePath
  }

  // ── 启动 / 停止 dsh 服务 ─────────────────────────────────────────────────────

  @ReactMethod
  fun startDsh(port: Int, promise: Promise) {
    if (dshProcess?.isAlive == true) {
      promise.resolve(true)
      return
    }
    Thread {
      try {
        val dshBin = File(prefixDir, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")
        if (!dshBin.exists()) {
          promise.reject("not_installed", "dsh 未安装，请先初始化环境")
          return@Thread
        }
        val pb = ProcessBuilder(
          File(prefixDir, "bin/bash").absolutePath,
          "-c",
          "exec node --expose-internals '$dshBin' web --host 127.0.0.1 --port $port",
        )
        pb.environment().putAll(termuxEnv())
        pb.redirectErrorStream(true)
        val proc = pb.start()
        dshProcess = proc
        // 启动日志静默消费，避免管道阻塞
        val reader = proc.inputStream.bufferedReader()
        val sink = Thread {
          reader.forEachLine { emitProgress(it, -1) }
        }
        sink.isDaemon = true
        sink.start()
        // 等待端口可探测
        val ok = waitForPort(port, 30000)
        if (ok) promise.resolve(true)
        else promise.reject("start_failed", "dsh 服务启动超时")
      } catch (e: Exception) {
        promise.reject("start_error", e.message ?: "start error")
      }
    }.start()
  }

  @ReactMethod
  fun stopDsh(promise: Promise) {
    try {
      dshProcess?.destroy()
      dshProcess = null
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("stop_error", e.message ?: "stop error")
    }
  }

  private fun waitForPort(port: Int, timeoutMs: Long): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      try {
        val socket = java.net.Socket()
        socket.connect(java.net.InetSocketAddress("127.0.0.1", port), 500)
        socket.close()
        return true
      } catch (_: Exception) {
        Thread.sleep(400)
      }
    }
    return false
  }

  // ── 后台运行 + 通知 ────────────────────────────────────────────────────────

  @Volatile private var notifyObserver: FileObserver? = null
  /** 通知 ID 递增计数器，避免与后台常驻通知（1001）撞号而互相顶掉。 */
  private val notifyId = java.util.concurrent.atomic.AtomicInteger(2000)
  /** 通知渠道：后台常驻（低优先级）与任务通知（高优先级）。 */
  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val bg = NotificationChannel(
      "dsh-bg", "后台运行", NotificationManager.IMPORTANCE_LOW,
    )
    bg.description = "DeepSeek Harness 在后台运行"
    manager.createNotificationChannel(bg)
    val task = NotificationChannel(
      "dsh-task", "任务通知", NotificationManager.IMPORTANCE_HIGH,
    )
    task.description = "AI 任务完成、定时任务等通知"
    manager.createNotificationChannel(task)
  }

  /**
   * 启动前台服务保活：App 退后台/锁屏后，Termux 内 dsh 进程与定时任务继续运行。
   * 同时注册 notify 目录监视器（dsh 引擎的 dsh/notify 事件经插件写入该目录）。
   */
  @ReactMethod
  fun startBackgroundService(promise: Promise) {
    try {
      ensureChannels()
      val intent = Intent(reactContext, TermuxService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
      startNotifyWatcher()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("service_error", e.message ?: "service error")
    }
  }

  /** 发送一条任务通知（供 JS 侧直接调用，例如错误提示）。 */
  @ReactMethod
  fun postNotification(title: String, body: String, promise: Promise) {
    try {
      showNotification(title, body)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("notify_error", e.message ?: "notify error")
    }
  }

  /** 把一条已交付产物保存到 Download/DeepSeekHarness（应用内「一键保存」按钮调用）。 */
  @ReactMethod
  fun saveDeliver(path: String, name: String, promise: Promise) {
    Thread {
      try {
        DeliverSaver.save(reactContext, path, name)
        showNotification("已保存", "已保存到 Download/DeepSeekHarness/$name")
        promise.resolve(true)
      } catch (e: Exception) {
        showNotification("保存失败", e.message ?: "保存失败")
        promise.reject("save_error", e.message ?: "save failed")
      }
    }.start()
  }

  /** Android 13+ 自动申请通知权限（弹系统授权框）；旧版本直接放行。 */
  @ReactMethod
  fun requestNotificationPermission(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        val activity = reactContext.currentActivity
        if (activity != null &&
          activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
          activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("permission_error", e.message ?: "permission error")
    }
  }

  /** App 通知开关是否开启（Android 13 上老 targetSdk 无法运行时申请，需引导用户去设置）。 */
  @ReactMethod
  fun isNotificationEnabled(promise: Promise) {
    try {
      val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      promise.resolve(manager.areNotificationsEnabled())
    } catch (e: Exception) {
      promise.reject("permission_error", e.message ?: "permission error")
    }
  }

  /** 跳转到本应用的系统通知设置页，让用户手动开启通知。 */
  @ReactMethod
  fun openNotificationSettings(promise: Promise) {
    try {
      val intent = Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("settings_error", e.message ?: "open settings error")
    }
  }

  private fun showNotification(title: String, body: String, savePath: String? = null, saveName: String? = null) {
    ensureChannels()
    val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // deliver 产物：点击通知触发 DeliverReceiver 保存到 Download/DeepSeekHarness
    val contentIntent: PendingIntent = if (savePath != null) {
      val intent = Intent(reactContext, DeliverReceiver::class.java)
        .putExtra("path", savePath)
        .putExtra("name", saveName ?: "artifact")
      PendingIntent.getBroadcast(
        reactContext, notifyId.getAndIncrement(), intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    } else {
      PendingIntent.getActivity(
        reactContext, 0, Intent(reactContext, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(reactContext, "dsh-task")
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(reactContext)
    }
    val notification = builder
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(body)
      .setContentIntent(contentIntent)
      .setAutoCancel(true)
      .build()
    manager.notify(notifyId.getAndIncrement(), notification)
  }

  /**
   * 监视 <files>/notify 目录：dsh 引擎（dsh-mobile-bridge 插件）把 dsh/notify
   * 事件写成 JSON 文件，这里发现新文件即弹系统通知并删除。全程原生层，后台可靠。
   */
  private fun startNotifyWatcher() {
    if (notifyObserver != null) return
    val dir = File(filesDir, "notify")
    dir.mkdirs()
    val observer = object : FileObserver(dir.absolutePath) {
      override fun onEvent(event: Int, path: String?) {
        if (path == null) return
        val create = event and (FileObserver.CREATE or FileObserver.MOVED_TO)
        if (create == 0) return
        // 只处理 .json（桥接层先写 .tmp 再原子 rename 成 .json）；
        // .tmp 是写入中的临时文件，读了会得到半截内容，且可能误删
        if (!path.endsWith(".json")) return
        val file = File(dir, path)
        // 独立线程处理：FileObserver 在文件创建瞬间触发（内容可能尚未写完），
        // 重试读取避免解析空/半截 JSON；若在监视线程里 sleep 会阻塞后续通知
        Thread {
          var text: String? = null
          for (i in 0 until 5) {
            try {
              val t = file.readText()
              if (t.isNotBlank()) { text = t; break }
            } catch (_: Exception) {}
            try { Thread.sleep(200) } catch (_: InterruptedException) { break }
          }
          if (text != null) {
            try {
              val json = JSONObject(text)
              val kind = json.optString("kind", "")
              val path = json.optString("path", "")
              val name = json.optString("name", "")
              // deliver 产物：携带 path 时点击通知 → DeliverReceiver 保存
              val savePath = if (kind == "deliver" && path.isNotEmpty()) path else null
              showNotification(
                json.optString("title", "DeepSeek Harness"),
                json.optString("body", ""),
                savePath,
                if (savePath != null) (if (name.isNotEmpty()) name else "artifact") else null,
              )
              // 产物交付事件 → React Native（显示「产物标签 + 一键保存」横幅）
              if (savePath != null) {
                try {
                  val params = Arguments.createMap()
                  params.putString("path", savePath)
                  params.putString("name", if (name.isNotEmpty()) name else "artifact")
                  reactContext.emitDeviceEvent("TermuxEngine/deliver", params)
                } catch (e: Exception) {
                  Log.w("TermuxEngine", "emit deliver ignored: ${e.message}")
                }
              }
              Log.d("TermuxEngine", "notify: ${json.optString("title", "")} / ${json.optString("body", "")}")
            } catch (e: Exception) {
              Log.w("TermuxEngine", "notify parse failed: ${e.message}")
            }
          }
          file.delete()
        }.start()
      }
    }
    notifyObserver = observer
    observer.startWatching()
    Log.d("TermuxEngine", "notify watcher started: ${dir.absolutePath}")
  }

  override fun invalidate() {
    super.invalidate()
    try { notifyObserver?.stopWatching() } catch (_: Exception) {}
    notifyObserver = null
    try { dshProcess?.destroy() } catch (_: Exception) {}
    dshProcess = null
  }
}
