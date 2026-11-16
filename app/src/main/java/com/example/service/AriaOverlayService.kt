package com.example.service

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import androidx.core.content.ContextCompat
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.example.MainActivity
import com.example.R
import com.example.brain.AriaAgentLoop
import com.example.brain.OpenRouterClient
import com.example.data.AriaPreferences
import com.example.model.AvatarState
import com.example.ui.AriaOverlayContent
import com.example.voice.AriaSpeechEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlin.math.abs

class AriaOverlayService : Service(), LifecycleOwner, SavedStateRegistryOwner {

    private val tag = "AriaOverlayService"
    private val lifecycleRegistry = LifecycleRegistry(this)
    private val savedStateRegistryController = SavedStateRegistryController.create(this)
    override val lifecycle: Lifecycle get() = lifecycleRegistry
    override val savedStateRegistry: SavedStateRegistry get() = savedStateRegistryController.savedStateRegistry

    private var windowManager: WindowManager? = null
    private var overlayView: View? = null
    private var layoutParams: WindowManager.LayoutParams? = null

    private lateinit var prefs: AriaPreferences
    lateinit var speechEngine: AriaSpeechEngine
        private set
    lateinit var agentLoop: AriaAgentLoop
        private set

    private val scope = CoroutineScope(Dispatchers.Main)
    private var bubbleDismissJob: Job? = null

    private val _speechBubbleText = MutableStateFlow<String?>(null)
    val speechBubbleText: StateFlow<String?> = _speechBubbleText.asStateFlow()

    companion object {
        private const val CHANNEL_ID = "aria_overlay_channel"
        private const val NOTIFICATION_ID = 1001

        var instance: AriaOverlayService? = null
            private set

        val isRunning: Boolean get() = instance != null

        fun start(context: Context) {
            val intent = Intent(context, AriaOverlayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, AriaOverlayService::class.java)
            context.stopService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        savedStateRegistryController.performRestore(null)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)

        prefs = AriaPreferences(this)
        speechEngine = AriaSpeechEngine(this, prefs)
        val openRouterClient = OpenRouterClient(prefs)
        agentLoop = AriaAgentLoop(this, prefs, speechEngine, openRouterClient)

        // Setup speech engine callbacks
        speechEngine.onCommandReceived = { command ->
            showSpeechBubble("You: $command")
            prefs.addChatMessage(sender = "USER", text = command)
            agentLoop.executeUserCommand(command)
        }

        speechEngine.onSpeechBubbleText = { text ->
            showSpeechBubble(text)
        }

        createNotificationChannel()
        startForegroundWithNotification()
        createFloatingOverlay()

        val hasMicPermission = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        if (hasMicPermission) {
            speechEngine.startListening()
        } else {
            Log.i(tag, "Awaiting microphone permission before starting speech listener")
        }
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
    }

    fun onMicrophonePermissionGranted() {
        startForegroundWithNotification()
        speechEngine.startListening()
    }

    private fun showSpeechBubble(text: String) {
        _speechBubbleText.value = text
        bubbleDismissJob?.cancel()
        bubbleDismissJob = scope.launch {
            delay(8000)
            if (_speechBubbleText.value == text) {
                _speechBubbleText.value = null
            }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Aria Voice Assistant",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Foreground service keeping Aria floating assistant alive."
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun startForegroundWithNotification() {
        val launchIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Aria Assistant Active")
            .setContentText("Listening for wake phrase '${prefs.wakePhrase}'")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val hasMicPermission = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED

            var started = false
            if (hasMicPermission) {
                try {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                    )
                    started = true
                } catch (e: SecurityException) {
                    Log.w(tag, "Failed to start FGS with MICROPHONE type: ${e.message}, falling back to SPECIAL_USE")
                }
            }

            if (!started) {
                try {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    )
                } catch (e: Exception) {
                    Log.w(tag, "Failed to start FGS with SPECIAL_USE: ${e.message}, starting with 0")
                    startForeground(NOTIFICATION_ID, notification, 0)
                }
            }
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun createFloatingOverlay() {
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager

        val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        layoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            layoutType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 24
            y = 350
        }

        val composeView = ComposeView(this).apply {
            setViewTreeLifecycleOwner(this@AriaOverlayService)
            setViewTreeSavedStateRegistryOwner(this@AriaOverlayService)
            setContent {
                val state by speechEngine.avatarState.collectAsState()
                val emotion by speechEngine.currentEmotion.collectAsState()
                val amplitude by speechEngine.audioAmplitude.collectAsState()
                val isReadingScreen by AriaAccessibilityService.isReadingScreen.collectAsState()
                val isAwarenessActive by AriaAccessibilityService.isAwarenessActive.collectAsState()
                val bubbleText by speechBubbleText.collectAsState()
                val isWorking by agentLoop.isTaskRunning.collectAsState()

                val customAvatarUri = prefs.customAvatarUri
                val overlaySize = prefs.overlaySizeDp.dp

                AriaOverlayContent(
                    avatarState = state,
                    emotion = emotion,
                    audioAmplitude = amplitude,
                    isReadingScreen = isReadingScreen,
                    isAwarenessActive = isAwarenessActive,
                    speechBubbleText = bubbleText,
                    isWorking = isWorking,
                    customAvatarUri = customAvatarUri,
                    avatarSize = overlaySize,
                    onAvatarSingleTap = {
                        toggleInputFocus(true)
                        if (state == AvatarState.SLEEPING) {
                            speechEngine.wakeUp()
                        }
                    },
                    onAvatarLongPress = {
                        if (state != AvatarState.SLEEPING) {
                            speechEngine.goToSleep("Hiding for now.")
                        } else {
                            speechEngine.wakeUp()
                        }
                    },
                    onSendCommand = { typedCommand ->
                        toggleInputFocus(false)
                        showSpeechBubble("You: $typedCommand")
                        prefs.addChatMessage(sender = "USER", text = typedCommand)
                        agentLoop.executeUserCommand(typedCommand)
                    },
                    onMicTap = {
                        speechEngine.wakeUp()
                    },
                    onDismissBubble = {
                        toggleInputFocus(false)
                        _speechBubbleText.value = null
                    }
                )
            }
        }

        // Draggable touch handler with free movement anywhere on the screen
        var initialX = 0
        var initialY = 0
        var initialTouchX = 0f
        var initialTouchY = 0f
        var isDragging = false

        composeView.setOnTouchListener { _, event ->
            val lp = layoutParams ?: return@setOnTouchListener false
            val displayMetrics = resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels
            val screenHeight = displayMetrics.heightPixels
            val viewWidth = overlayView?.width ?: 200
            val viewHeight = overlayView?.height ?: 200

            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = lp.x
                    initialY = lp.y
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    isDragging = false
                    false
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - initialTouchX
                    val dy = event.rawY - initialTouchY
                    if (abs(dx) > 10 || abs(dy) > 10) {
                        isDragging = true
                        // Calculate new position clamped within screen bounds
                        val newX = (initialX + dx).toInt().coerceIn(0, screenWidth - viewWidth)
                        val newY = (initialY + dy).toInt().coerceIn(0, screenHeight - viewHeight)
                        lp.x = newX
                        lp.y = newY
                        try {
                            windowManager?.updateViewLayout(overlayView, lp)
                        } catch (e: Exception) {
                            Log.w(tag, "Layout update error: ${e.message}")
                        }
                        true
                    } else false
                }

                MotionEvent.ACTION_UP -> {
                    if (isDragging) {
                        // If free movement is disabled in settings, gently snap to left or right edge.
                        // By default, freeMovementEnabled is true: stays right where the user dropped it!
                        if (!prefs.freeMovementEnabled) {
                            val targetX = if (lp.x + (viewWidth / 2) < screenWidth / 2) {
                                16 // Snap to left edge
                            } else {
                                screenWidth - viewWidth - 16 // Snap to right edge
                            }
                            animateSnapTo(lp.x, targetX, lp.y)
                        }
                        true
                    } else {
                        false
                    }
                }

                else -> false
            }
        }

        overlayView = composeView
        try {
            windowManager?.addView(overlayView, layoutParams)
        } catch (e: Exception) {
            Log.e(tag, "Failed to add floating window: ${e.message}")
        }
    }

    private fun animateSnapTo(fromX: Int, toX: Int, currentY: Int) {
        val lp = layoutParams ?: return
        scope.launch {
            val steps = 8
            for (i in 1..steps) {
                val progress = i / steps.toFloat()
                lp.x = (fromX + (toX - fromX) * progress).toInt()
                lp.y = currentY
                try {
                    windowManager?.updateViewLayout(overlayView, lp)
                } catch (e: Exception) {
                    break
                }
                delay(12)
            }
        }
    }

    private fun toggleInputFocus(focus: Boolean) {
        val lp = layoutParams ?: return
        if (focus) {
            lp.flags = lp.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
        } else {
            lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        }
        try {
            windowManager?.updateViewLayout(overlayView, lp)
        } catch (e: Exception) {
            Log.w(tag, "Focus toggle error: ${e.message}")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)

        bubbleDismissJob?.cancel()
        speechEngine.destroy()

        if (overlayView != null) {
            try {
                windowManager?.removeView(overlayView)
            } catch (e: Exception) {
                Log.w(tag, "Error removing overlay: ${e.message}")
            }
            overlayView = null
        }
        instance = null
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
