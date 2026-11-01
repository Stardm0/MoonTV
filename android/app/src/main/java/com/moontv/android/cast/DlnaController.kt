package com.moontv.android.cast

interface DlnaController {
    suspend fun discover(timeoutMs: Long = 5_000): List<DlnaDevice>
    suspend fun cast(device: DlnaDevice, media: CastMedia): Boolean
    suspend fun play(): Boolean
    suspend fun pause(): Boolean
    suspend fun stop(): Boolean
    suspend fun seek(positionMs: Long): Boolean
    suspend fun playbackState(): RemotePlaybackState
    suspend fun progress(): Pair<Long, Long>?
    suspend fun volume(): Pair<Int?, Boolean?>?
    fun close()
}
