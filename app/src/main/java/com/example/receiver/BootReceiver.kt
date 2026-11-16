package com.example.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.example.data.AriaPreferences
import com.example.service.AriaOverlayService

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val prefs = AriaPreferences(context)
            if (prefs.startOnBoot) {
                Log.i("BootReceiver", "Starting AriaOverlayService on boot as requested in settings")
                AriaOverlayService.start(context)
            }
        }
    }
}
