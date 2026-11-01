package com.moontv.android.cast

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.moontv.android.MainActivity
import com.moontv.android.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class DlnaSessionService : Service() {
    inner class LocalBinder : Binder() {
        val service: DlnaSessionService get() = this@DlnaSessionService
    }

    private val binder = LocalBinder()
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var controller: DlnaController
    private var pollJob: Job? = null

    private val mutableState = MutableStateFlow(CastSessionState())
    val state: StateFlow<CastSessionState> = mutableState.asStateFlow()

    override fun onCreate() {
        super.onCreate()
        controller = UpnpCastController(this)
        createNotificationChannel()
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> ensureForeground()
            ACTION_TOGGLE -> togglePlayback()
            ACTION_STOP -> stopCasting()
        }
        return if (mutableState.value.active || mutableState.value.connecting) {
            START_STICKY
        } else {
            START_NOT_STICKY
        }
    }

    fun discover(callback: (Result<List<DlnaDevice>>) -> Unit) {
        serviceScope.launch {
            callback(runCatching { controller.discover() })
        }
    }

    fun cast(device: DlnaDevice, media: CastMedia, callback: (Result<Unit>) -> Unit) {
        ensureForeground()
        pollJob?.cancel()
        mutableState.value = CastSessionState(
            connecting = true,
            device = device,
            media = media,
            positionMs = media.positionMs,
            durationMs = media.durationMs,
        )
        updateNotification()

        serviceScope.launch {
            val result = runCatching {
                check(controller.cast(device, media)) { "电视拒绝了播放请求" }
            }
            if (result.isSuccess) {
                mutableState.update {
                    it.copy(
                        active = true,
                        connecting = false,
                        playbackState = RemotePlaybackState.PLAYING,
                        error = null,
                    )
                }
                startPolling()
                callback(Result.success(Unit))
            } else {
                val message = result.exceptionOrNull()?.message ?: "未知错误"
                mutableState.update {
                    it.copy(connecting = false, playbackState = RemotePlaybackState.ERROR, error = message)
                }
                updateNotification()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                callback(Result.failure(result.exceptionOrNull() ?: IllegalStateException(message)))
            }
        }
    }

    fun togglePlayback() {
        serviceScope.launch {
            val current = mutableState.value.playbackState
            val success = if (current == RemotePlaybackState.PLAYING || current == RemotePlaybackState.BUFFERING) {
                controller.pause()
            } else {
                controller.play()
            }
            if (success) {
                mutableState.update {
                    it.copy(
                        playbackState = if (current == RemotePlaybackState.PLAYING || current == RemotePlaybackState.BUFFERING) {
                            RemotePlaybackState.PAUSED
                        } else {
                            RemotePlaybackState.PLAYING
                        },
                    )
                }
                updateNotification()
            }
        }
    }

    fun seekBy(deltaMs: Long) {
        serviceScope.launch {
            val snapshot = mutableState.value
            val upperBound = snapshot.durationMs.takeIf { it > 0 } ?: Long.MAX_VALUE
            val target = (snapshot.positionMs + deltaMs).coerceIn(0, upperBound)
            if (controller.seek(target)) {
                mutableState.update { it.copy(positionMs = target) }
            }
        }
    }

    fun stopCasting() {
        serviceScope.launch {
            runCatching { controller.stop() }
            endSession()
        }
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = serviceScope.launch {
            while (mutableState.value.active) {
                runCatching {
                    val playback = controller.playbackState()
                    val progress = controller.progress()
                    val volume = controller.volume()
                    mutableState.update {
                        it.copy(
                            playbackState = playback,
                            positionMs = progress?.first ?: it.positionMs,
                            durationMs = progress?.second?.takeIf { value -> value > 0 } ?: it.durationMs,
                            volume = volume?.first ?: it.volume,
                            muted = volume?.second ?: it.muted,
                            error = null,
                        )
                    }
                    updateNotification()
                }.onFailure { error ->
                    mutableState.update { it.copy(error = error.message) }
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    private fun endSession() {
        pollJob?.cancel()
        mutableState.update {
            it.copy(
                active = false,
                connecting = false,
                playbackState = RemotePlaybackState.STOPPED,
            )
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun ensureForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification() {
        if (!mutableState.value.active && !mutableState.value.connecting) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val snapshot = mutableState.value
        val deviceName = snapshot.device?.name ?: getString(R.string.cast_idle)
        val content = when {
            snapshot.connecting -> getString(R.string.connecting_device, deviceName)
            snapshot.media != null -> snapshot.media.title
            else -> getString(R.string.cast_idle)
        }
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val toggle = PendingIntent.getService(
            this,
            1,
            Intent(this, DlnaSessionService::class.java).setAction(ACTION_TOGGLE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            2,
            Intent(this, DlnaSessionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val toggleIcon = if (snapshot.playbackState == RemotePlaybackState.PLAYING) {
            R.drawable.ic_pause
        } else {
            R.drawable.ic_play
        }
        val toggleLabel = if (snapshot.playbackState == RemotePlaybackState.PLAYING) "暂停" else "播放"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_cast)
            .setContentTitle(getString(R.string.cast_connected, deviceName))
            .setContentText(content)
            .setContentIntent(openApp)
            .setOnlyAlertOnce(true)
            .setOngoing(snapshot.active || snapshot.connecting)
            .addAction(toggleIcon, toggleLabel, toggle)
            .addAction(R.drawable.ic_stop, "停止", stop)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "DLNA 投屏",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "显示电视播放状态和控制按钮"
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onDestroy() {
        pollJob?.cancel()
        controller.close()
        serviceScope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "com.moontv.android.cast.START"
        const val ACTION_TOGGLE = "com.moontv.android.cast.TOGGLE"
        const val ACTION_STOP = "com.moontv.android.cast.STOP"

        private const val CHANNEL_ID = "dlna_cast"
        private const val NOTIFICATION_ID = 1001
        private const val POLL_INTERVAL_MS = 2_000L
    }
}
