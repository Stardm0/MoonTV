package com.moontv.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.moontv.android.cast.CastMedia
import com.moontv.android.cast.CastSessionState
import com.moontv.android.cast.DlnaDevice
import com.moontv.android.cast.DlnaSessionService
import com.moontv.android.cast.RemotePlaybackState
import com.moontv.android.databinding.ActivityMainBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Locale

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var dlnaService: DlnaSessionService? = null
    private var serviceBound = false
    private var stateJob: Job? = null
    private var bridgeRegistered = false
    private var configuredOrigin: String? = null
    private var currentMedia: CastMedia? = null
    private var lastState = CastSessionState()
    private var lastShownError: String? = null
    private var loadErrorDialogShown = false
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var orientationBeforeFullscreen = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    private val preferences by lazy {
        getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            dlnaService = (binder as? DlnaSessionService.LocalBinder)?.service
            serviceBound = dlnaService != null
            observeSession()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            stateJob?.cancel()
            stateJob = null
            serviceBound = false
            dlnaService = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        configureSystemBars()
        setupWindowInsets()
        setupWebView()
        setupCastControls()
        setupBackNavigation()

        val serverUrl = preferences.getString(KEY_SERVER_URL, null)
        if (serverUrl == null) {
            showServerDialog(required = true)
        } else {
            loadServer(serverUrl)
        }
    }

    override fun onStart() {
        super.onStart()
        bindService(
            Intent(this, DlnaSessionService::class.java),
            serviceConnection,
            Context.BIND_AUTO_CREATE,
        )
    }

    override fun onStop() {
        stateJob?.cancel()
        stateJob = null
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        dlnaService = null
        super.onStop()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(binding.webView, false)
        binding.webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            if (!userAgentString.contains(ANDROID_USER_AGENT_MARKER)) {
                userAgentString = "$userAgentString $ANDROID_USER_AGENT_MARKER/${BuildConfig.VERSION_NAME}"
            }
        }
        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.pageProgress.isVisible = newProgress in 1..99
            }

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null || callback == null) return
                enterFullscreen(view, callback)
            }

            override fun onHideCustomView() {
                exitFullscreen()
            }
        }
        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                loadErrorDialogShown = false
                binding.pageProgress.isVisible = true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                binding.pageProgress.isVisible = false
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val target = request?.url ?: return false
                if (originOf(target) == configuredOrigin) return false
                startActivity(Intent(Intent.ACTION_VIEW, target))
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame != true || loadErrorDialogShown) return
                loadErrorDialogShown = true
                binding.pageProgress.isVisible = false
                MaterialAlertDialogBuilder(this@MainActivity)
                    .setTitle("无法加载 MoonTV")
                    .setMessage("请检查服务地址和网络连接。")
                    .setPositiveButton("修改服务地址") { _, _ ->
                        showServerDialog(required = true)
                    }
                    .setNegativeButton("重试") { _, _ -> view?.reload() }
                    .show()
            }
        }
    }

    private fun setupWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val scrimParams = binding.statusBarScrim.layoutParams
            if (scrimParams.height != systemBars.top) {
                scrimParams.height = systemBars.top
                binding.statusBarScrim.layoutParams = scrimParams
            }
            binding.mainContent.setPadding(
                systemBars.left,
                0,
                systemBars.right,
                systemBars.bottom,
            )
            insets
        }
    }

    private fun configureSystemBars() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
            show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden()
            return
        }
        fullscreenView = view
        fullscreenCallback = callback
        orientationBeforeFullscreen = requestedOrientation

        (view.parent as? ViewGroup)?.removeView(view)
        binding.fullscreenContainer.addView(
            view,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        binding.mainContent.isVisible = false
        binding.fullscreenContainer.isVisible = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun exitFullscreen(): Boolean {
        val view = fullscreenView ?: return false
        fullscreenView = null
        binding.fullscreenContainer.removeView(view)
        binding.fullscreenContainer.isVisible = false
        binding.mainContent.isVisible = true
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestedOrientation = orientationBeforeFullscreen

        val callback = fullscreenCallback
        fullscreenCallback = null
        callback?.onCustomViewHidden()
        configureSystemBars()
        ViewCompat.requestApplyInsets(binding.root)
        return true
    }

    private fun setupCastControls() {
        binding.playPause.setOnClickListener { dlnaService?.togglePlayback() }
        binding.seekBack.setOnClickListener { dlnaService?.seekBy(-30_000) }
        binding.seekForward.setOnClickListener { dlnaService?.seekBy(30_000) }
        binding.stopCast.setOnClickListener { dlnaService?.stopCasting() }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (exitFullscreen()) {
                    return
                } else if (binding.webView.canGoBack()) {
                    binding.webView.goBack()
                } else {
                    finish()
                }
            }
        })
    }

    private fun showServerDialog(required: Boolean) {
        val input = EditText(this).apply {
            hint = getString(R.string.server_url_hint)
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_URI
            setText(preferences.getString(KEY_SERVER_URL, ""))
            setSelection(text.length)
        }
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.server_url_title)
            .setView(input)
            .setCancelable(!required)
            .setNegativeButton(if (required) null else "取消", null)
            .setPositiveButton("保存", null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val normalized = normalizeServerUrl(input.text.toString())
                if (normalized == null) {
                    input.error = getString(R.string.server_url_error)
                    return@setOnClickListener
                }
                preferences.edit { putString(KEY_SERVER_URL, normalized) }
                loadServer(normalized)
                dialog.dismiss()
            }
        }
        dialog.show()
    }

    private fun loadServer(serverUrl: String) {
        val uri = serverUrl.toUri()
        val origin = originOf(uri) ?: return
        configuredOrigin = origin
        installMessageBridge(origin)
        binding.webView.loadUrl(serverUrl)
    }

    @SuppressLint("RequiresFeature")
    private fun installMessageBridge(origin: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            MaterialAlertDialogBuilder(this)
                .setTitle("系统 WebView 版本过低")
                .setMessage("请先在应用商店更新 Android System WebView，再使用投屏功能。")
                .setPositiveButton("知道了", null)
                .show()
            return
        }
        if (bridgeRegistered) {
            WebViewCompat.removeWebMessageListener(binding.webView, BRIDGE_NAME)
        }
        WebViewCompat.addWebMessageListener(
            binding.webView,
            BRIDGE_NAME,
            setOf(origin),
        ) { _, message, sourceOrigin, isMainFrame, _ ->
            if (!isMainFrame || sourceOrigin.toString() != origin) return@addWebMessageListener
            handleWebMessage(message.data ?: return@addWebMessageListener)
        }
        bridgeRegistered = true
    }

    private fun handleWebMessage(rawMessage: String) {
        runCatching {
            val message = JSONObject(rawMessage)
            if (message.optInt("version") != BRIDGE_VERSION) return
            when (message.optString("type")) {
                "action" -> {
                    when (message.optString("action")) {
                        "discover" -> binding.root.post { beginDiscovery() }
                        "open-settings" -> binding.root.post { showServerDialog(required = false) }
                    }
                    return
                }

                "media" -> Unit
                else -> return
            }
            val url = message.optString("url")
            val uri = url.toUri()
            if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) return
            currentMedia = CastMedia(
                url = url,
                title = message.optString("title").ifBlank { "MoonTV 视频" },
                positionMs = (message.optDouble("position", 0.0) * 1_000).toLong().coerceAtLeast(0),
                durationMs = (message.optDouble("duration", 0.0) * 1_000).toLong().coerceAtLeast(0),
            )
        }
    }

    private fun beginDiscovery() {
        val media = currentMedia
        if (media == null) {
            Toast.makeText(this, R.string.no_media, Toast.LENGTH_SHORT).show()
            return
        }
        val service = dlnaService
        if (service == null) {
            Toast.makeText(this, "投屏服务正在启动，请稍后重试", Toast.LENGTH_SHORT).show()
            return
        }
        requestNotificationPermissionIfNeeded()

        val progress = ProgressBar(this).apply {
            val padding = (24 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
        }
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.searching_devices)
            .setView(progress)
            .setNegativeButton("取消", null)
            .create()
        dialog.show()

        service.discover { result ->
            if (isFinishing || isDestroyed) return@discover
            dialog.dismiss()
            result.onSuccess { devices ->
                showDevicePicker(devices, media)
            }.onFailure { error ->
                showError("搜索电视失败：${error.message ?: "未知错误"}")
            }
        }
    }

    private fun showDevicePicker(devices: List<DlnaDevice>, media: CastMedia) {
        if (devices.isEmpty()) {
            MaterialAlertDialogBuilder(this)
                .setMessage(R.string.no_devices)
                .setPositiveButton("重试") { _, _ -> beginDiscovery() }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        val labels = devices.map { "${it.name}\n${it.address}" }.toTypedArray()
        MaterialAlertDialogBuilder(this)
            .setTitle("选择电视")
            .setItems(labels) { _, index -> castTo(devices[index], media) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun castTo(device: DlnaDevice, media: CastMedia) {
        val service = dlnaService ?: return
        ContextCompat.startForegroundService(
            this,
            Intent(this, DlnaSessionService::class.java).setAction(DlnaSessionService.ACTION_START),
        )
        Toast.makeText(this, getString(R.string.connecting_device, device.name), Toast.LENGTH_SHORT).show()
        service.cast(device, media) { result ->
            if (isFinishing || isDestroyed) return@cast
            result.onSuccess {
                dispatchNativeControl("pause-local")
                Toast.makeText(
                    this,
                    getString(R.string.cast_connected, device.name),
                    Toast.LENGTH_SHORT,
                ).show()
            }.onFailure { error ->
                showError(getString(R.string.cast_failed, error.message ?: "未知错误"))
            }
        }
    }

    private fun observeSession() {
        stateJob?.cancel()
        val service = dlnaService ?: return
        stateJob = lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                service.state.collect { renderSession(it) }
            }
        }
    }

    private fun renderSession(state: CastSessionState) {
        val wasActive = lastState.active || lastState.connecting
        lastState = state
        binding.castControls.isVisible = state.active
        binding.castDevice.text = state.device?.let { getString(R.string.cast_connected, it.name) }.orEmpty()
        binding.castProgress.text = buildString {
            append(formatTime(state.positionMs))
            append(" / ")
            append(formatTime(state.durationMs))
            append(" · ")
            append(playbackLabel(state.playbackState))
        }
        binding.playPause.setIconResource(
            if (state.playbackState == RemotePlaybackState.PLAYING ||
                state.playbackState == RemotePlaybackState.BUFFERING
            ) {
                R.drawable.ic_pause
            } else {
                R.drawable.ic_play
            },
        )
        dispatchNativeState(state)

        if (wasActive && !state.active && !state.connecting) {
            dispatchNativeControl("cast-stopped")
        }
        if (state.error != null && state.error != lastShownError) {
            lastShownError = state.error
            Toast.makeText(this, state.error, Toast.LENGTH_SHORT).show()
        } else if (state.error == null) {
            lastShownError = null
        }
    }

    private fun dispatchNativeState(state: CastSessionState) {
        val media = state.media ?: return
        val payload = JSONObject()
            .put("version", BRIDGE_VERSION)
            .put("type", "cast-state")
            .put("active", state.active)
            .put("connecting", state.connecting)
            .put("url", media.url)
            .put("title", media.title)
            .put("position", state.positionMs / 1_000.0)
            .put("duration", state.durationMs / 1_000.0)
            .put("playbackState", state.playbackState.name.lowercase(Locale.ROOT))
            .put("deviceName", state.device?.name ?: "")
        dispatchWebEvent("moontv-native-state", payload)
    }

    private fun dispatchNativeControl(action: String) {
        val payload = JSONObject()
            .put("version", BRIDGE_VERSION)
            .put("action", action)
        dispatchWebEvent("moontv-native-control", payload)
    }

    private fun dispatchWebEvent(eventName: String, payload: JSONObject) {
        val json = JSONObject.quote(payload.toString())
        binding.webView.post {
            binding.webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('$eventName',{detail:JSON.parse($json)}));",
                null,
            )
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun showError(message: String) {
        MaterialAlertDialogBuilder(this)
            .setMessage(message)
            .setPositiveButton("知道了", null)
            .show()
    }

    private fun normalizeServerUrl(input: String): String? {
        val trimmed = input.trim().trimEnd('/')
        val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
        val uri = withScheme.toUri()
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) return null
        return uri.toString()
    }

    private fun originOf(uri: Uri): String? {
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        val host = uri.host ?: return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    private fun formatTime(milliseconds: Long): String {
        if (milliseconds <= 0) return "00:00"
        val totalSeconds = milliseconds / 1_000
        val hours = totalSeconds / 3_600
        val minutes = (totalSeconds % 3_600) / 60
        val seconds = totalSeconds % 60
        return if (hours > 0) {
            String.format(Locale.ROOT, "%02d:%02d:%02d", hours, minutes, seconds)
        } else {
            String.format(Locale.ROOT, "%02d:%02d", minutes, seconds)
        }
    }

    private fun playbackLabel(state: RemotePlaybackState): String = when (state) {
        RemotePlaybackState.IDLE -> "等待播放"
        RemotePlaybackState.PLAYING -> "播放中"
        RemotePlaybackState.PAUSED -> "已暂停"
        RemotePlaybackState.STOPPED -> "已停止"
        RemotePlaybackState.BUFFERING -> "缓冲中"
        RemotePlaybackState.ERROR -> "播放异常"
    }

    override fun onDestroy() {
        exitFullscreen()
        if (bridgeRegistered && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(binding.webView, BRIDGE_NAME)
        }
        binding.webView.stopLoading()
        binding.webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val PREFERENCES_NAME = "moontv_android"
        private const val KEY_SERVER_URL = "server_url"
        private const val BRIDGE_NAME = "MoonTVNative"
        private const val BRIDGE_VERSION = 1
        private const val ANDROID_USER_AGENT_MARKER = "MoonTVAndroid"
    }
}
