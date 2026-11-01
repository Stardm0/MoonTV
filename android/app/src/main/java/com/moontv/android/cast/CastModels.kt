package com.moontv.android.cast

data class DlnaDevice(
    val id: String,
    val name: String,
    val address: String,
    val isTv: Boolean,
)

data class CastMedia(
    val url: String,
    val title: String,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
)

enum class RemotePlaybackState {
    IDLE,
    PLAYING,
    PAUSED,
    STOPPED,
    BUFFERING,
    ERROR,
}

data class CastSessionState(
    val active: Boolean = false,
    val connecting: Boolean = false,
    val device: DlnaDevice? = null,
    val media: CastMedia? = null,
    val playbackState: RemotePlaybackState = RemotePlaybackState.IDLE,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val volume: Int? = null,
    val muted: Boolean? = null,
    val error: String? = null,
)
