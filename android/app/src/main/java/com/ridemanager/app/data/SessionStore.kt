package com.ridemanager.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Sign-in tokens, encrypted at rest with a key held in the Android Keystore.
 * Nothing else is stored on the device: every screen reads live data from the server.
 */
class SessionStore(context: Context) {
    private val prefs: SharedPreferences = open(context.applicationContext)

    private fun open(context: Context): SharedPreferences = try {
        create(context)
    } catch (e: Exception) {
        // A restored or corrupted keystore makes the old file unreadable: start clean (the user signs in again).
        context.deleteSharedPreferences(FILE)
        create(context)
    }

    private fun create(context: Context): SharedPreferences {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        return EncryptedSharedPreferences.create(
            context, FILE, key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var accessToken: String?
        get() = prefs.getString("access", null)
        private set(v) = prefs.edit().putString("access", v).apply()
    var refreshToken: String?
        get() = prefs.getString("refresh", null)
        private set(v) = prefs.edit().putString("refresh", v).apply()
    /** Unix seconds at which the access token expires. */
    var expiresAt: Long
        get() = prefs.getLong("expires", 0)
        private set(v) = prefs.edit().putLong("expires", v).apply()
    var userId: String?
        get() = prefs.getString("uid", null)
        private set(v) = prefs.edit().putString("uid", v).apply()
    /** Last time the user touched the app (milliseconds) — used for the inactivity sign-out. */
    var lastActiveAt: Long
        get() = prefs.getLong("active", 0)
        set(v) = prefs.edit().putLong("active", v).apply()
    var timeoutMinutes: Int
        get() = prefs.getInt("timeout", 30)
        set(v) = prefs.edit().putInt("timeout", v).apply()

    val signedIn: Boolean get() = !accessToken.isNullOrEmpty() && !refreshToken.isNullOrEmpty()

    fun save(access: String, refresh: String, expiresInSeconds: Long, uid: String?) {
        accessToken = access
        refreshToken = refresh
        expiresAt = System.currentTimeMillis() / 1000 + expiresInSeconds
        if (uid != null) userId = uid
        lastActiveAt = System.currentTimeMillis()
    }

    fun clear() = prefs.edit().clear().apply()

    private companion object { const val FILE = "rms_session" }
}
