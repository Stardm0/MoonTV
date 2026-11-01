package com.moontv.android.cast

import android.content.Context
import com.yinnho.upnpcast.CastOptions
import com.yinnho.upnpcast.DLNACast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class UpnpCastController(context: Context) : DlnaController {
    init {
        DLNACast.init(context.applicationContext)
    }

    override suspend fun discover(timeoutMs: Long): List<DlnaDevice> = withContext(Dispatchers.IO) {
        DLNACast.search(timeoutMs)
            .filter { it.isTV }
            .distinctBy { it.id }
            .map { DlnaDevice(it.id, it.name, it.address, it.isTV) }
            .sortedBy { it.name.lowercase() }
    }

    override suspend fun cast(device: DlnaDevice, media: CastMedia): Boolean =
        withContext(Dispatchers.IO) {
            DLNACast.clearProgressCache()
            val target = DLNACast.Device(device.id, device.name, device.address, device.isTv)
            val accepted = DLNACast.castToDevice(
                device = target,
                url = media.url,
                title = media.title,
                options = CastOptions(mimeType = guessMimeType(media.url)),
            )
            if (accepted && media.positionMs > 1_000) {
                DLNACast.seek(media.positionMs)
            }
            accepted
        }

    override suspend fun play(): Boolean = withContext(Dispatchers.IO) { DLNACast.play() }

    override suspend fun pause(): Boolean = withContext(Dispatchers.IO) { DLNACast.pause() }

    override suspend fun stop(): Boolean = withContext(Dispatchers.IO) { DLNACast.stop() }

    override suspend fun seek(positionMs: Long): Boolean =
        withContext(Dispatchers.IO) { DLNACast.seek(positionMs.coerceAtLeast(0)) }

    override suspend fun playbackState(): RemotePlaybackState = withContext(Dispatchers.IO) {
        when (DLNACast.getPlaybackState()) {
            DLNACast.PlaybackState.IDLE -> RemotePlaybackState.IDLE
            DLNACast.PlaybackState.PLAYING -> RemotePlaybackState.PLAYING
            DLNACast.PlaybackState.PAUSED -> RemotePlaybackState.PAUSED
            DLNACast.PlaybackState.STOPPED -> RemotePlaybackState.STOPPED
            DLNACast.PlaybackState.BUFFERING -> RemotePlaybackState.BUFFERING
            DLNACast.PlaybackState.ERROR -> RemotePlaybackState.ERROR
        }
    }

    override suspend fun progress(): Pair<Long, Long>? =
        withContext(Dispatchers.IO) { DLNACast.getProgressRealtime() }

    override suspend fun volume(): Pair<Int?, Boolean?>? =
        withContext(Dispatchers.IO) { DLNACast.getVolume() }

    override fun close() {
        DLNACast.cleanup()
    }

    private fun guessMimeType(url: String): String? {
        val path = url.substringBefore('?').substringBefore('#').lowercase()
        return when {
            path.endsWith(".m3u8") -> "application/vnd.apple.mpegurl"
            path.endsWith(".mp4") -> "video/mp4"
            path.endsWith(".mkv") -> "video/x-matroska"
            path.endsWith(".webm") -> "video/webm"
            path.endsWith(".mp3") -> "audio/mpeg"
            else -> null
        }
    }
}
