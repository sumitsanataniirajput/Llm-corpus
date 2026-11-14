package com.example.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.example.data.AriaPreferences
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.ByteArrayOutputStream
import java.util.Locale

data class ScreenElement(
    val id: String,
    val className: String,
    val text: String,
    val contentDescription: String,
    val bounds: Rect,
    val isClickable: Boolean,
    val isEditable: Boolean,
    val isPassword: Boolean
)

data class ScreenHierarchy(
    val packageName: String,
    val elements: List<ScreenElement>,
    val compactTreeText: String,
    val isProtectedBanking: Boolean,
    val protectionReason: String? = null,
    val isIgnoredApp: Boolean = false,
    val timestamp: Long = System.currentTimeMillis()
)

class AriaAccessibilityService : AccessibilityService() {

    private val tag = "AriaAccessibility"
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var prefs: AriaPreferences

    companion object {
        var instance: AriaAccessibilityService? = null
            private set

        val isRunning: Boolean get() = instance != null

        private val _isServiceConnected = MutableStateFlow(false)
        val isServiceConnected: StateFlow<Boolean> = _isServiceConnected.asStateFlow()

        // Active screen awareness indicator dot
        private val _isAwarenessActive = MutableStateFlow(false)
        val isAwarenessActive: StateFlow<Boolean> = _isAwarenessActive.asStateFlow()

        private val _isReadingScreen = MutableStateFlow(false)
        val isReadingScreen: StateFlow<Boolean> = _isReadingScreen.asStateFlow()

        // In-memory volatile snapshot (NEVER written to disk or history)
        var latestScreenSnapshot: ScreenHierarchy? = null
            private set

        var onUserInterrupted: (() -> Unit)? = null

        private val BANKING_KEYWORDS = listOf(
            "bank", "upi", "paytm", "gpay", "google pay", "phonepe", "paypal",
            "chase", "wells fargo", "credit card", "debit card", "cvv", "atm pin",
            "net banking", "card number", "passcode", "security pin", "one time password"
        )

        private val BANKING_PACKAGES = listOf(
            "com.google.android.apps.nbu.paisa.user",
            "net.one97.paytm",
            "com.phonepe.app",
            "com.chase.sig.android",
            "com.wf.wellsfargomobile",
            "com.bofa.mobilebanking",
            "com.paypal.android.p2pmobile"
        )
    }

    // Power & Screen State
    private var isScreenOn = true
    private var isBatterySufficient = true
    private var lastScanTime = 0L
    private var scanPending = false

    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    isScreenOn = false
                    updateAwarenessStatus()
                }
                Intent.ACTION_SCREEN_ON -> {
                    isScreenOn = true
                    updateAwarenessStatus()
                    scheduleThrottledScan()
                }
                Intent.ACTION_BATTERY_CHANGED -> {
                    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
                    val batteryPct = if (level >= 0 && scale > 0) (level * 100 / scale) else 100
                    val minThreshold = prefs.minBatteryThreshold
                    isBatterySufficient = batteryPct >= minThreshold
                    updateAwarenessStatus()
                }
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        _isServiceConnected.value = true
        prefs = AriaPreferences(this)

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_BATTERY_CHANGED)
        }
        registerReceiver(powerReceiver, filter)

        updateAwarenessStatus()
        scheduleThrottledScan()
        Log.i(tag, "AriaAccessibilityService connected with always-on awareness")
    }

    private fun updateAwarenessStatus() {
        val active = prefs.screenAwarenessEnabled && isScreenOn && isBatterySufficient
        _isAwarenessActive.value = active
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return

        // Abort task if user touches the screen manually during automation
        if (event.eventType == AccessibilityEvent.TYPE_TOUCH_INTERACTION_START ||
            event.eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            val sourcePackage = event.packageName?.toString() ?: ""
            if (!sourcePackage.contains("aria")) {
                onUserInterrupted?.invoke()
            }
        }

        // Always-on screen awareness: listen for UI changes, throttled
        if (prefs.screenAwarenessEnabled && isScreenOn && isBatterySufficient) {
            when (event.eventType) {
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
                AccessibilityEvent.TYPE_WINDOWS_CHANGED,
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                    scheduleThrottledScan()
                }
            }
        }
    }

    private fun scheduleThrottledScan() {
        val now = System.currentTimeMillis()
        if (now - lastScanTime < 800) {
            if (!scanPending) {
                scanPending = true
                mainHandler.postDelayed({
                    scanPending = false
                    executeMemoryScan()
                }, 800 - (now - lastScanTime))
            }
            return
        }
        executeMemoryScan()
    }

    private fun executeMemoryScan() {
        lastScanTime = System.currentTimeMillis()
        _isReadingScreen.value = true
        try {
            latestScreenSnapshot = readCurrentScreen()
        } catch (e: Exception) {
            Log.w(tag, "Screen awareness scan error: ${e.message}")
        } finally {
            _isReadingScreen.value = false
        }
    }

    override fun onInterrupt() {
        Log.w(tag, "AriaAccessibilityService interrupted")
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unregisterReceiver(powerReceiver)
        } catch (e: Exception) {}
        if (instance == this) {
            instance = null
            _isServiceConnected.value = false
            _isAwarenessActive.value = false
            _isReadingScreen.value = false
            latestScreenSnapshot = null
        }
    }

    /**
     * Reads current screen hierarchy into volatile memory.
     * Skips password fields, banking/payment screens, and user-ignored apps.
     */
    fun readCurrentScreen(): ScreenHierarchy {
        val rootNode = rootInActiveWindow
        if (rootNode == null) {
            return ScreenHierarchy(
                packageName = "unknown",
                elements = emptyList(),
                compactTreeText = "Screen is empty or unavailable.",
                isProtectedBanking = false
            )
        }

        val pkgName = rootNode.packageName?.toString() ?: "unknown"

        // Check if app is in user's ignored apps list
        val ignoredList = prefs.loadIgnoredApps()
        if (ignoredList.any { pkgName.contains(it, ignoreCase = true) }) {
            return ScreenHierarchy(
                packageName = pkgName,
                elements = emptyList(),
                compactTreeText = "[Ignored App: $pkgName - screen content skipped per settings]",
                isProtectedBanking = false,
                isIgnoredApp = true
            )
        }

        val elements = mutableListOf<ScreenElement>()
        val treeBuilder = StringBuilder()

        var isBankingDetected = false
        var safetyReason: String? = null

        for (bPkg in BANKING_PACKAGES) {
            if (pkgName.lowercase(Locale.ROOT).contains(bPkg)) {
                isBankingDetected = true
                safetyReason = "Protected financial/banking app detected: $pkgName"
                break
            }
        }

        fun traverse(node: AccessibilityNodeInfo, depth: Int) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)

            val isPassword = node.isPassword
            val rawText = if (isPassword) "[PROTECTED_PASSWORD]" else (node.text?.toString() ?: "")
            val contentDesc = if (isPassword) "[PROTECTED]" else (node.contentDescription?.toString() ?: "")

            val lowerCombo = "${rawText.lowercase(Locale.ROOT)} ${contentDesc.lowercase(Locale.ROOT)}"
            for (keyword in BANKING_KEYWORDS) {
                if (lowerCombo.contains(keyword)) {
                    isBankingDetected = true
                    safetyReason = "Protected financial/security content detected ('$keyword')"
                }
            }

            // OTP filter
            val sanitizedText = if (isPassword) {
                "[PROTECTED]"
            } else if (Regex("\\b\\d{4,8}\\b").containsMatchIn(rawText) &&
                (lowerCombo.contains("otp") || lowerCombo.contains("code") || lowerCombo.contains("verification"))) {
                "[OTP_REDACTED]"
            } else {
                rawText
            }

            val viewId = node.viewIdResourceName?.substringAfter(":id/") ?: ""
            val className = node.className?.toString()?.substringAfterLast(".") ?: "View"
            val isClickable = node.isClickable
            val isEditable = node.isEditable

            if (sanitizedText.isNotBlank() || contentDesc.isNotBlank() || isClickable || isEditable) {
                elements.add(
                    ScreenElement(
                        id = viewId,
                        className = className,
                        text = sanitizedText,
                        contentDescription = contentDesc,
                        bounds = bounds,
                        isClickable = isClickable,
                        isEditable = isEditable,
                        isPassword = isPassword
                    )
                )

                val indent = "  ".repeat(depth.coerceAtMost(4))
                val descPart = if (contentDesc.isNotBlank()) " desc=\"$contentDesc\"" else ""
                val idPart = if (viewId.isNotBlank()) " id=\"$viewId\"" else ""
                val clickPart = if (isClickable) " [Clickable]" else ""
                val editPart = if (isEditable) " [Editable]" else ""
                val boundsPart = " at=(${bounds.centerX()},${bounds.centerY()})"

                val label = if (sanitizedText.isNotBlank()) "\"$sanitizedText\"" else ""
                treeBuilder.appendLine("$indent<$className$label$descPart$idPart$clickPart$editPart$boundsPart>")
            }

            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { child ->
                    traverse(child, depth + 1)
                }
            }
        }

        traverse(rootNode, 0)

        val compactText = if (isBankingDetected) {
            "SAFETY ALERT: Banking or payment screen detected ($safetyReason). Content is protected and redacted."
        } else if (elements.isEmpty()) {
            "Screen active window ($pkgName) has no readable text elements."
        } else {
            treeBuilder.toString().trim()
        }

        return ScreenHierarchy(
            packageName = pkgName,
            elements = if (isBankingDetected) emptyList() else elements,
            compactTreeText = compactText,
            isProtectedBanking = isBankingDetected,
            protectionReason = safetyReason
        )
    }

    /**
     * Returns the latest in-memory screen snapshot, or scans if not yet cached
     */
    fun getLatestAwarenessSnapshot(): ScreenHierarchy {
        val cached = latestScreenSnapshot
        val now = System.currentTimeMillis()
        return if (cached != null && now - cached.timestamp < 3000) {
            cached
        } else {
            readCurrentScreen().also { latestScreenSnapshot = it }
        }
    }

    suspend fun takeScreenBitmap(): Bitmap? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val deferred = CompletableDeferred<Bitmap?>()
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                mainExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshotResult: ScreenshotResult) {
                        try {
                            val bitmap = Bitmap.wrapHardwareBuffer(
                                screenshotResult.hardwareBuffer,
                                screenshotResult.colorSpace
                            )?.copy(Bitmap.Config.ARGB_8888, false)
                            screenshotResult.hardwareBuffer.close()
                            deferred.complete(bitmap)
                        } catch (e: Exception) {
                            Log.e(tag, "Screenshot wrap error: ${e.message}")
                            deferred.complete(null)
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.e(tag, "takeScreenshot failed: $errorCode")
                        deferred.complete(null)
                    }
                }
            )
            return deferred.await()
        }
        return null
    }

    suspend fun captureScreenshotBase64(): String? {
        val bitmap = takeScreenBitmap() ?: return null
        return try {
            val outputStream = ByteArrayOutputStream()
            val scaled = Bitmap.createScaledBitmap(bitmap, bitmap.width / 2, bitmap.height / 2, true)
            scaled.compress(Bitmap.CompressFormat.JPEG, 75, outputStream)
            val bytes = outputStream.toByteArray()
            Base64.encodeToString(bytes, Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.e(tag, "Base64 encode error: ${e.message}")
            null
        }
    }

    fun tapCoordinates(x: Float, y: Float, onComplete: ((Boolean) -> Unit)? = null) {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 80)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { onComplete?.invoke(true) }
            override fun onCancelled(gestureDescription: GestureDescription?) { onComplete?.invoke(false) }
        }, null)
    }

    fun tapElement(identifier: String, onComplete: ((Boolean) -> Unit)? = null) {
        val hierarchy = getLatestAwarenessSnapshot()
        val target = hierarchy.elements.find {
            it.text.contains(identifier, ignoreCase = true) ||
            it.contentDescription.contains(identifier, ignoreCase = true) ||
            it.id.equals(identifier, ignoreCase = true)
        }

        if (target != null) {
            tapCoordinates(target.bounds.centerX().toFloat(), target.bounds.centerY().toFloat(), onComplete)
        } else {
            onComplete?.invoke(false)
        }
    }

    fun longPress(x: Float, y: Float, durationMs: Long = 800, onComplete: ((Boolean) -> Unit)? = null) {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { onComplete?.invoke(true) }
            override fun onCancelled(gestureDescription: GestureDescription?) { onComplete?.invoke(false) }
        }, null)
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long = 300, onComplete: ((Boolean) -> Unit)? = null) {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { onComplete?.invoke(true) }
            override fun onCancelled(gestureDescription: GestureDescription?) { onComplete?.invoke(false) }
        }, null)
    }

    fun typeText(text: String, onComplete: ((Boolean) -> Unit)? = null) {
        val root = rootInActiveWindow
        val focused = root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && focused.isEditable) {
            val arguments = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            val success = focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
            onComplete?.invoke(success)
        } else {
            val editableNode = findFirstEditable(root)
            if (editableNode != null) {
                val arguments = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
                }
                val success = editableNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
                onComplete?.invoke(success)
            } else {
                onComplete?.invoke(false)
            }
        }
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val found = findFirstEditable(node.getChild(i))
            if (found != null) return found
        }
        return null
    }

    fun pressBack(): Boolean = performGlobalAction(GLOBAL_ACTION_BACK)
    fun pressHome(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)
    fun pressRecents(): Boolean = performGlobalAction(GLOBAL_ACTION_RECENTS)
}
