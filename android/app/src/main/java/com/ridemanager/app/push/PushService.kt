package com.ridemanager.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.ridemanager.app.MainActivity
import com.ridemanager.app.R
import com.ridemanager.app.data.SessionStore
import com.ridemanager.app.data.SupabaseApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.time.OffsetDateTime
import kotlin.coroutines.resume

/** Receives push messages sent by the "notify" Edge Function through Firebase Cloud Messaging. */
class PushService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        val store = SessionStore(this)
        if (store.signedIn) scope.launch { runCatching { Push.saveToken(SupabaseApi(store), store, token) } }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: return
        val body = message.notification?.body ?: message.data["body"].orEmpty()
        Push.show(this, title, body, message.data["priority"] == "emergency")
    }
}

object Push {
    const val CHANNEL = "alerts"

    fun createChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL, context.getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH)
        channel.description = context.getString(R.string.channel_alerts_desc)
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun permitted(context: Context): Boolean =
        android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun show(context: Context, title: String, body: String, emergency: Boolean) {
        if (!permitted(context)) return
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(if (emergency) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
            .setCategory(if (emergency) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        try {
            NotificationManagerCompat.from(context).notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), n)
        } catch (e: SecurityException) {
            // Permission was withdrawn between the check and the call: nothing to show.
        }
    }

    /**
     * Asks Firebase for this device's push token and stores it for the signed-in user.
     * Returns a short status text. Push is optional: without app/google-services.json this reports "not configured".
     */
    suspend fun register(api: SupabaseApi, store: SessionStore): String {
        val token = try {
            suspendCancellableCoroutine<String?> { cont ->
                FirebaseMessaging.getInstance().token
                    .addOnSuccessListener { cont.resume(it) }
                    .addOnFailureListener { cont.resume(null) }
            }
        } catch (e: IllegalStateException) {
            return "Not configured (google-services.json was not added when the app was built)"
        }
        if (token.isNullOrEmpty()) return "Could not get a push token from Google. Check the internet connection and Google Play services."
        return try {
            saveToken(api, store, token)
            "Enabled on this phone"
        } catch (e: Exception) {
            "Could not save the push token: ${e.message}"
        }
    }

    suspend fun saveToken(api: SupabaseApi, store: SessionStore, token: String) {
        val uid = store.userId ?: return
        api.upsert("device_tokens", "token", JSONObject()
            .put("user_id", uid).put("app", "manager").put("platform", "android").put("token", token)
            .put("last_seen_at", OffsetDateTime.now().toString()))
    }
}
