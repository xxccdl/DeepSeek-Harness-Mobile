# DeepSeek Harness Mobile v1.0.6

## AI 直接看图（视觉优化）

- **AI 直接用 read_image 看图**：多模态（视觉）模型下，AI 会直接用 `read_image` 工具读取图片并把图片附到对话中查看，无需再绕道 `vision_analyze`；`vision_analyze` 仅用于非视觉模型或手机控制自动截屏场景
- **手机控制视觉模式更顺滑**：配合模型类型自动识别（1.0.5），手机控制时 AI 可先截屏直接看画面，再点击/滑动/输入完成操控

## 安装
下载 `app-release.apk` 直接安装覆盖即可（Gitee 为分卷压缩，全部下载后解压）。
