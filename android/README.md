# MoonTV Android 手机端

这个 APK 保留 MoonTV 的服务端架构：搜索、登录、收藏和播放记录仍由现有 MoonTV 服务提供，手机端用 WebView 展示页面，仅把设备发现和 DLNA 控制放到原生 Android 层。

## 当前功能

- 配置并保存 MoonTV 服务地址，登录 Cookie 保存在 APK 自己的 WebView 中。
- 搜索同一局域网内的 DLNA MediaRenderer 电视。
- 将播放页当前视频地址、标题和进度投放到指定电视。
- 远端播放、暂停、前后 30 秒、停止以及进度轮询。
- 投屏期间使用前台服务和系统通知保持控制会话。
- 将电视端进度同步回 MoonTV 播放记录，避免手机本地播放器的旧进度覆盖远端进度。

DLNA 实现使用 [UPnPCast v1.3.0](https://github.com/yinnho/UPnPCast/releases/tag/v1.3.0)，应用代码通过 `DlnaController` 隔离第三方接口，后续可以按电视兼容性替换实现。

## 构建

要求：

- Android Studio 或 JDK 17
- Android SDK 36

```bash
cd android
./gradlew assembleDebug
```

生成文件位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

安装到已开启 USB 调试的手机：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

正式分发前需要配置独立的 release 签名；不要把签名文件和密码提交到仓库。

## 使用

1. 安装 APK，首次打开时输入现有 MoonTV 服务地址，例如 `https://moon.example.com`。
2. 确认该服务已经部署本分支包含的网页桥接改动；只更新 APK 而不更新 MoonTV 网页时，APK 无法取得当前媒体地址。
3. 在 APK 内完成 MoonTV 登录并打开一个视频播放页。
4. 点击播放器控制栏中的投屏图标，选择电视。手机和电视必须在同一个局域网。
5. 投屏成功后，底部控制条和系统通知都可以控制电视播放。

如果电视没有被发现，先确认电视已开启“DLNA 投屏/媒体投放”，并关闭路由器的访客网络或 AP 隔离。

## 当前边界

- 当前发送的是播放源原始 URL。电视必须能直接访问该地址，并支持对应容器、编码和 HLS 特性。
- 网页端的去广告 HLS Loader、请求头、Cookie 和弹幕不会自动传到电视。对于依赖这些能力的源，需要后续增加手机本地 HLS 代理。
- 自动下一集暂未接管电视端播放结束事件；切集后需要再次点击投屏。
- UPnPCast 自带的本地文件服务器不是完整的 HLS 代理，不能解决带鉴权请求头、动态 Cookie 或广告片段过滤问题。
- Android 17 / targetSdk 37 起，SSDP 需要新增 `ACCESS_LOCAL_NETWORK` 运行时权限；当前工程 targetSdk 为 36，不应提前声明该权限。

## 代码结构

- `MainActivity.kt`：安全 WebView、服务地址、设备选择和网页消息桥。
- `DlnaSessionService.kt`：后台会话、状态轮询、通知和播放控制。
- `DlnaController.kt`：项目内部的 DLNA 抽象。
- `UpnpCastController.kt`：UPnPCast v1.3.0 适配实现。
- `src/app/play/page.tsx`：向 APK 提供当前媒体上下文，并接收电视端进度。
