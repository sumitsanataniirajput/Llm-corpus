package com.example.brain

import android.app.SearchManager
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import com.example.data.AriaPreferences
import com.example.model.ActionHistoryItem
import com.example.model.AvatarState
import com.example.service.AriaAccessibilityService
import com.example.voice.AriaSpeechEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

class AriaAgentLoop(
    private val context: Context,
    private val prefs: AriaPreferences,
    private val speechEngine: AriaSpeechEngine,
    private val openRouterClient: OpenRouterClient
) {

    private val tag = "AriaAgentLoop"
    private val scope = CoroutineScope(Dispatchers.Main)
    private var currentTaskJob: Job? = null

    private val _isTaskRunning = MutableStateFlow(false)
    val isTaskRunning: StateFlow<Boolean> = _isTaskRunning.asStateFlow()

    private val _taskProgress = MutableStateFlow("")
    val taskProgress: StateFlow<String> = _taskProgress.asStateFlow()

    private var pendingConfirmationAction: (() -> Unit)? = null

    init {
        // Abort task if user touches the screen manually during automation
        AriaAccessibilityService.onUserInterrupted = {
            if (_isTaskRunning.value) {
                abortTask("Task stopped because you touched the screen.")
            }
        }
    }

    fun abortTask(reason: String = "Task cancelled.") {
        if (_isTaskRunning.value) {
            currentTaskJob?.cancel()
            _isTaskRunning.value = false
            _taskProgress.value = ""
            pendingConfirmationAction = null
            speechEngine.setAvatarState(AvatarState.LISTENING)
            speechEngine.speak(reason)
            prefs.addActionHistory(
                ActionHistoryItem(
                    id = UUID.randomUUID().toString(),
                    actionType = "ABORT",
                    description = reason,
                    status = "CANCELLED"
                )
            )
        }
    }

    /**
     * Executes user request with autonomous agent loop and safety guardrails
     */
    fun executeUserCommand(command: String) {
        val cleanCommand = command.trim()
        if (cleanCommand.isBlank()) return

        // Check if answering pending confirmation
        if (pendingConfirmationAction != null) {
            val lower = cleanCommand.lowercase()
            if (lower.contains("yes") || lower.contains("confirm") || lower.contains("sure") || lower.contains("proceed") || lower.contains("do it")) {
                speechEngine.speak("Confirmed. Proceeding.")
                val action = pendingConfirmationAction
                pendingConfirmationAction = null
                action?.invoke()
                return
            } else if (lower.contains("no") || lower.contains("cancel") || lower.contains("stop") || lower.contains("don't")) {
                pendingConfirmationAction = null
                speechEngine.speak("Action cancelled.")
                speechEngine.setAvatarState(AvatarState.LISTENING)
                return
            }
        }

        // Check if command is a memory statement ("remember that my birthday is July 4", "note that I like tea")
        if (cleanCommand.startsWith("remember that", ignoreCase = true) ||
            cleanCommand.startsWith("remember", ignoreCase = true) ||
            cleanCommand.startsWith("note that", ignoreCase = true)) {
            val fact = cleanCommand.replace(Regex("^(remember that|remember|note that)\\s*", RegexOption.IGNORE_CASE), "").trim()
            if (fact.isNotBlank()) {
                prefs.addMemory(fact)
                speechEngine.speak("I'll remember that $fact.")
                prefs.addActionHistory(
                    ActionHistoryItem(
                        id = UUID.randomUUID().toString(),
                        actionType = "MEMORY",
                        description = "Saved memory: $fact",
                        status = "SUCCESS"
                    )
                )
                return
            }
        }

        // Screen question / read screen queries
        val lower = cleanCommand.lowercase()
        val isScreenReadQuery = lower.contains("what's on my screen") ||
                lower.contains("what is on my screen") ||
                lower.contains("read this") ||
                lower.contains("read screen") ||
                lower.contains("summarize this page") ||
                lower.contains("summarize screen")

        currentTaskJob?.cancel()
        currentTaskJob = scope.launch {
            _isTaskRunning.value = true
            speechEngine.setAvatarState(AvatarState.WORKING)

            var step = 0
            val maxSteps = 25
            var isFinished = false
            val conversationHistory = mutableListOf<Pair<String, String>>()
            var activeGoal = cleanCommand

            try {
                while (step < maxSteps && !isFinished && _isTaskRunning.value) {
                    step++
                    _taskProgress.value = "Step $step: Reading screen..."

                    // 1. Read in-memory screen snapshot & Safety Check
                    val accessibilityService = AriaAccessibilityService.instance
                    val hierarchy = accessibilityService?.getLatestAwarenessSnapshot()

                    if (hierarchy?.isProtectedBanking == true) {
                        val reason = hierarchy.protectionReason ?: "Banking or payment screen detected."
                        speechEngine.speak("Uh-oh! That's a banking or payment screen, so I'm staying away for your safety!", com.example.model.AriaEmotion.SCARED)
                        prefs.addActionHistory(
                            ActionHistoryItem(
                                id = UUID.randomUUID().toString(),
                                actionType = "SAFETY_REFUSAL",
                                description = "Refused banking screen interaction",
                                status = "REFUSED_SAFETY",
                                details = reason
                            )
                        )
                        isFinished = true
                        break
                    }

                    val screenContext = hierarchy?.compactTreeText ?: "Screen unavailable"

                    // Use screenshot plus vision model only when text tree is empty or not enough
                    val activeModel = prefs.getActiveModel()
                    val textTreeNotEnough = hierarchy == null || hierarchy.elements.size < 2 || screenContext.length < 50
                    val screenshotBase64 = if (activeModel?.supportsImages == true && textTreeNotEnough) {
                        accessibilityService?.captureScreenshotBase64()
                    } else null

                    // 2. Query Brain
                    speechEngine.setAvatarState(AvatarState.THINKING)
                    val response = openRouterClient.query(
                        userMessage = activeGoal,
                        screenContext = screenContext,
                        screenshotBase64 = screenshotBase64,
                        history = conversationHistory,
                        enableTools = true
                    )

                    // 3. Handle emotional sentences response
                    if (response.sentences.isNotEmpty()) {
                        speechEngine.speakEmotionalSentences(response.sentences)
                        conversationHistory.add("assistant" to response.rawText)
                        val combinedText = response.sentences.joinToString(" ") { it.text }
                        val primaryEmotion = response.sentences.firstOrNull()?.emotion ?: com.example.model.AriaEmotion.HAPPY
                        prefs.addChatMessage(sender = "ARIA", text = combinedText, emotion = primaryEmotion)
                        prefs.addActionHistory(
                            ActionHistoryItem(
                                id = UUID.randomUUID().toString(),
                                actionType = if (isScreenReadQuery) "SCREEN_READ" else "CHAT",
                                description = cleanCommand,
                                status = "SUCCESS",
                                details = combinedText
                            )
                        )
                    }

                    if (response.toolCalls.isEmpty()) {
                        isFinished = true
                        break
                    }

                    // 4. Handle Tool Calls
                    if (response.toolCalls.isNotEmpty()) {
                        speechEngine.setAvatarState(AvatarState.WORKING)
                        for (toolCall in response.toolCalls) {
                            val actionDesc = executeToolCall(toolCall, accessibilityService)
                            _taskProgress.value = "Executed: $actionDesc"
                            conversationHistory.add("assistant" to "Executed tool ${toolCall.name} ($actionDesc)")

                            if (toolCall.name == "finish") {
                                isFinished = true
                                break
                            }
                            if (toolCall.name == "ask_user") {
                                isFinished = true
                                break
                            }
                        }
                        delay(600) // Brief delay to let screen update
                    } else {
                        isFinished = true
                    }
                }
            } catch (e: Exception) {
                Log.e(tag, "Agent loop error: ${e.message}", e)
                speechEngine.speak("I encountered an issue completing that task.")
            } finally {
                _isTaskRunning.value = false
                _taskProgress.value = ""
                if (speechEngine.avatarState.value == AvatarState.WORKING) {
                    speechEngine.setAvatarState(AvatarState.LISTENING)
                }
            }
        }
    }

    private suspend fun executeToolCall(toolCall: ToolCall, service: AriaAccessibilityService?): String {
        val args = try {
            JSONObject(toolCall.argumentsJson)
        } catch (e: Exception) {
            JSONObject()
        }

        return when (toolCall.name) {
            "tap" -> {
                val element = args.optString("element", "")
                val x = args.optDouble("x", -1.0).toFloat()
                val y = args.optDouble("y", -1.0).toFloat()

                if (x >= 0 && y >= 0) {
                    service?.tapCoordinates(x, y)
                    logAction("TAP", "Tapped screen at ($x, $y)")
                    "Tapped coordinates ($x, $y)"
                } else if (element.isNotBlank()) {
                    service?.tapElement(element)
                    logAction("TAP", "Tapped element '$element'")
                    "Tapped element '$element'"
                } else {
                    "No tap target"
                }
            }

            "long_press" -> {
                val x = args.optDouble("x", 500.0).toFloat()
                val y = args.optDouble("y", 500.0).toFloat()
                service?.longPress(x, y)
                logAction("LONG_PRESS", "Long pressed at ($x, $y)")
                "Long pressed at ($x, $y)"
            }

            "swipe" -> {
                val direction = args.optString("direction", "up").lowercase()
                val displayMetrics = context.resources.displayMetrics
                val midX = displayMetrics.widthPixels / 2f
                val midY = displayMetrics.heightPixels / 2f

                when (direction) {
                    "up" -> service?.swipe(midX, midY + 400, midX, midY - 400)
                    "down" -> service?.swipe(midX, midY - 400, midX, midY + 400)
                    "left" -> service?.swipe(midX + 300, midY, midX - 300, midY)
                    "right" -> service?.swipe(midX - 300, midY, midX + 300, midY)
                }
                logAction("SWIPE", "Swiped screen $direction")
                "Swiped $direction"
            }

            "type_text" -> {
                val text = args.optString("text", "")
                service?.typeText(text)
                logAction("TYPE", "Typed: $text")
                "Typed '$text'"
            }

            "press_back" -> {
                service?.pressBack()
                logAction("SYSTEM", "Pressed Back")
                "Pressed Back"
            }

            "press_home" -> {
                service?.pressHome()
                logAction("SYSTEM", "Pressed Home")
                "Pressed Home"
            }

            "open_app" -> {
                val name = args.optString("name", "")
                val launched = launchAppByName(name)
                val status = if (launched) "SUCCESS" else "FAILED"
                logAction("OPEN_APP", "Open app: $name", status)
                "Opened app '$name'"
            }

            "direct_intent" -> {
                val action = args.optString("action", "")
                val target = args.optString("target", "")
                val content = args.optString("content", "")
                executeDirectIntent(action, target, content)
            }

            "wait" -> {
                val seconds = args.optDouble("seconds", 1.0).coerceIn(0.5, 5.0)
                delay((seconds * 1000).toLong())
                "Waited ${seconds}s"
            }

            "ask_user" -> {
                val question = args.optString("question", "How would you like me to proceed?")
                speechEngine.speak(question)
                speechEngine.setAvatarState(AvatarState.LISTENING)
                logAction("ASK_USER", question)
                "Asked: $question"
            }

            "finish" -> {
                val summary = args.optString("summary", "Task completed.")
                speechEngine.speak(summary)
                logAction("FINISH", summary)
                "Finished: $summary"
            }

            else -> "Unknown tool: ${toolCall.name}"
        }
    }

    private fun executeDirectIntent(action: String, target: String, content: String): String {
        return when (action.lowercase()) {
            "call" -> {
                // Sensitive: requires confirmation
                requireSpokenConfirmation("call $target") {
                    try {
                        val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$target")).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        context.startActivity(intent)
                        logAction("CALL", "Calling $target")
                    } catch (e: Exception) {
                        speechEngine.speak("Unable to place call.")
                    }
                }
                "Requested confirmation to call $target"
            }

            "sms" -> {
                // Sensitive: requires confirmation
                requireSpokenConfirmation("send SMS to $target saying '$content'") {
                    try {
                        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$target")).apply {
                            putExtra("sms_body", content)
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        context.startActivity(intent)
                        logAction("SMS", "Sent SMS to $target")
                    } catch (e: Exception) {
                        speechEngine.speak("Unable to open SMS app.")
                    }
                }
                "Requested confirmation to send SMS"
            }

            "whatsapp" -> {
                try {
                    val url = "https://api.whatsapp.com/send?phone=$target&text=${Uri.encode(content)}"
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                    logAction("WHATSAPP", "Opened WhatsApp for $target")
                    "Opened WhatsApp message"
                } catch (e: Exception) {
                    "WhatsApp not installed or intent failed"
                }
            }

            "alarm" -> {
                try {
                    val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                        putExtra(AlarmClock.EXTRA_MESSAGE, content.ifBlank { "Aria Alarm" })
                        putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                    speechEngine.speak("Alarm set for you.")
                    logAction("ALARM", "Alarm set: $content")
                    "Alarm set"
                } catch (e: Exception) {
                    "Alarm intent failed"
                }
            }

            "timer" -> {
                try {
                    val seconds = content.toIntOrNull() ?: 300
                    val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                        putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                        putExtra(AlarmClock.EXTRA_MESSAGE, target.ifBlank { "Aria Timer" })
                        putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                    speechEngine.speak("Timer set for ${seconds / 60} minutes.")
                    logAction("TIMER", "Timer set: $seconds seconds")
                    "Timer set"
                } catch (e: Exception) {
                    "Timer intent failed"
                }
            }

            "calendar" -> {
                try {
                    val intent = Intent(Intent.ACTION_INSERT).apply {
                        data = CalendarContract.Events.CONTENT_URI
                        putExtra(CalendarContract.Events.TITLE, content.ifBlank { target })
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                    speechEngine.speak("Opening calendar to add event.")
                    logAction("CALENDAR", "Calendar event created")
                    "Calendar event created"
                } catch (e: Exception) {
                    "Calendar intent failed"
                }
            }

            "navigation" -> {
                try {
                    val gmmIntentUri = Uri.parse("google.navigation:q=${Uri.encode(target)}")
                    val mapIntent = Intent(Intent.ACTION_VIEW, gmmIntentUri).apply {
                        setPackage("com.google.android.apps.maps")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(mapIntent)
                    speechEngine.speak("Starting navigation to $target.")
                    logAction("NAVIGATION", "Navigating to $target")
                    "Navigating to $target"
                } catch (e: Exception) {
                    "Google Maps navigation failed"
                }
            }

            "music" -> {
                try {
                    val intent = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH).apply {
                        putExtra(SearchManager.QUERY, content.ifBlank { target })
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                    speechEngine.speak("Playing music.")
                    logAction("MUSIC", "Playing $content")
                    "Playing music"
                } catch (e: Exception) {
                    "Music intent failed"
                }
            }

            "flashlight" -> {
                try {
                    val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
                    val cameraId = cameraManager?.cameraIdList?.firstOrNull()
                    if (cameraId != null) {
                        cameraManager.setTorchMode(cameraId, true)
                        speechEngine.speak("Flashlight turned on.")
                        logAction("FLASHLIGHT", "Flashlight enabled")
                        "Flashlight enabled"
                    } else "No camera found"
                } catch (e: Exception) {
                    "Flashlight toggle error"
                }
            }

            "wifi_panel" -> {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val panelIntent = Intent(Settings.Panel.ACTION_WIFI).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        context.startActivity(panelIntent)
                    } else {
                        val intent = Intent(Settings.ACTION_WIFI_SETTINGS).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        context.startActivity(intent)
                    }
                    "Wi-Fi panel opened"
                } catch (e: Exception) {
                    "Wi-Fi panel failed"
                }
            }

            "bluetooth_panel" -> {
                try {
                    val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                    "Bluetooth panel opened"
                } catch (e: Exception) {
                    "Bluetooth panel failed"
                }
            }

            "settings" -> {
                try {
                    val intent = Intent(Settings.ACTION_SETTINGS).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                    "Settings opened"
                } catch (e: Exception) {
                    "Settings failed"
                }
            }

            else -> "Unknown direct intent $action"
        }
    }

    private fun requireSpokenConfirmation(actionDescription: String, onConfirmed: () -> Unit) {
        pendingConfirmationAction = onConfirmed
        speechEngine.setAvatarState(AvatarState.LISTENING)
        speechEngine.speak("Please confirm: Should I $actionDescription? Say yes to proceed, or no to cancel.")
        logAction("CONFIRMATION_REQUESTED", "Asked confirmation to $actionDescription", "CONFIRMATION_REQUIRED")
    }

    private fun launchAppByName(name: String): Boolean {
        val pm = context.packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        val apps = pm.queryIntentActivities(mainIntent, 0)
        val match = apps.find {
            it.loadLabel(pm).toString().contains(name, ignoreCase = true)
        }
        if (match != null) {
            val launchIntent = pm.getLaunchIntentForPackage(match.activityInfo.packageName)
            if (launchIntent != null) {
                launchIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
                context.startActivity(launchIntent)
                return true
            }
        }
        return false
    }

    private fun logAction(type: String, description: String, status: String = "SUCCESS", details: String = "") {
        prefs.addActionHistory(
            ActionHistoryItem(
                id = UUID.randomUUID().toString(),
                actionType = type,
                description = description,
                status = status,
                details = details
            )
        )
    }
}
