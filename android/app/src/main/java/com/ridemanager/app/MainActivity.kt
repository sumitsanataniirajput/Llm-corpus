package com.ridemanager.app

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ridemanager.app.push.Push
import com.ridemanager.app.ui.AppTheme
import com.ridemanager.app.ui.LoginScreen
import com.ridemanager.app.ui.MainScreen
import com.ridemanager.app.ui.MessageScreen

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Customer and driver details are on screen: keep them out of screenshots and the recent-apps preview.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        Push.createChannel(this)
        setContent {
            val state by vm.state.collectAsStateWithLifecycle()
            AppTheme {
                when (state.stage) {
                    Stage.NOT_CONFIGURED -> MessageScreen(
                        title = "App not configured",
                        text = "This build has no server address. Copy android/local.properties.example to android/local.properties, " +
                            "fill in SUPABASE_URL and SUPABASE_ANON_KEY, then build the app again. See SETUP.md.",
                    )
                    Stage.LOADING -> MessageScreen(title = state.appName, text = "Checking your session…", loading = true)
                    Stage.SIGNED_OUT, Stage.NEEDS_CODE -> LoginScreen(vm, state)
                    Stage.SIGNED_IN -> MainScreen(vm, state)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        vm.onForeground()
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        vm.touched()
    }
}
