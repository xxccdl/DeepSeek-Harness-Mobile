package com.dshmobile

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * 把 AI 产物从 <files>/deliver 复制到公开下载目录的 DeepSeekHarness 子目录。
 * Android 10+ 走 MediaStore.Downloads（无需写外部存储权限），旧版本走公开目录直写。
 * 供 DeliverReceiver（通知点击）与 TermuxEngine.saveDeliver（应用内按钮）复用。
 */
object DeliverSaver {

  fun save(context: Context, srcPath: String, name: String) {
    val src = File(srcPath)
    if (!src.exists()) throw IllegalStateException("源文件不存在")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, guessMime(name))
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DeepSeekHarness")
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("创建下载记录失败")
      resolver.openOutputStream(uri)?.use { out ->
        src.inputStream().use { it.copyTo(out) }
      } ?: throw IllegalStateException("打开输出流失败")
      return
    }
    val dir = File(
      Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
      "DeepSeekHarness",
    )
    dir.mkdirs()
    src.copyTo(File(dir, name), overwrite = true)
  }

  fun guessMime(name: String): String = when {
    name.endsWith(".png") -> "image/png"
    name.endsWith(".jpg") || name.endsWith(".jpeg") -> "image/jpeg"
    name.endsWith(".gif") -> "image/gif"
    name.endsWith(".webp") -> "image/webp"
    name.endsWith(".pdf") -> "application/pdf"
    name.endsWith(".txt") || name.endsWith(".md") -> "text/plain"
    name.endsWith(".mp4") -> "video/mp4"
    name.endsWith(".zip") -> "application/zip"
    else -> "application/octet-stream"
  }
}