package com.example.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.content.ContextCompat
import com.example.data.AriaPreferences
import com.example.model.AriaEmotion
import com.example.model.AvatarState
import com.example.model.EmotionalSentence
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.max

class AriaSpeechEngine(
    private val context: Context,
    private val prefs: AriaPreferences
) {

    private val tag = "AriaSpeechEngine"
    private val mainHandler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(Dispatchers.Main)

    val ttsManager = AriaTTSManager(context, prefs)

    // State flows
    private val _avatarState = MutableStateFlow(AvatarState.SLEEPING)
    val avatarState: StateFlow<AvatarState> = _avatarState.asStateFlow()

    val isSpeaking: StateFlow<Boolean> = ttsManager.isSpeaking
    val currentEmotion: StateFlow<AriaEmotion> = ttsManager.currentEmotion
    val audioAmplitude: StateFlow<Float> = ttsManager.audioAmplitude

    private val _lastRecognizedText = MutableStateFlow("")
    val lastRecognizedText: StateFlow<String> = _lastRecognizedText.asStateFlow()

    // Callbacks
    var onCommandReceived: ((String) -> Unit)? = null
    var onStateChanged: ((AvatarState) -> Unit)? = null
    var onSpeechBubbleText: ((String) -> Unit)? = null

    // Speech Recognizer
    private var speechRecognizer: SpeechRecognizer? = null
    private var isListening = false
    private var silenceRunnable: Runnable? = null

    init {
        ttsManager.onSpeechBubbleText = { text ->
            onSpeechBubbleText?.invoke(text)
        }

        scope.launch {
            ttsManager.isSpeaking.collect { speaking ->
                if (speaking && _avatarState.value != AvatarState.WORKING) {
                    setAvatarState(AvatarState.SPEAKING)
                } else if (!speaking && _avatarState.value == AvatarState.SPEAKING) {
                    setAvatarState(AvatarState.LISTENING)
                    resetSilenceTimer()
                }
            }
        }

        initializeSpeechRecognizer()
    }

    fun applyTtsSettings() {
        ttsManager.applyAndroidVoiceSettings()
    }

    fun speak(text: String, emotion: AriaEmotion = AriaEmotion.HAPPY, onFinished: (() -> Unit)? = null) {
        ttsManager.speakText(text, emotion) {
            onFinished?.invoke()
        }
    }

    fun speakEmotionalSentences(sentences: List<EmotionalSentence>, onFinished: (() -> Unit)? = null) {
        ttsManager.speakSentences(sentences) {
            onFinished?.invoke()
        }
    }

    fun stopSpeaking() {
        ttsManager.stop()
    }

    // --- Speech Recognition ---
    private fun initializeSpeechRecognizer() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            Log.w(tag, "SpeechRecognizer is not available on this device")
            return
        }

        mainHandler.post {
            try {
                speechRecognizer?.destroy()
                speechRecognizer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
                    SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                } else {
                    SpeechRecognizer.createSpeechRecognizer(context)
                }
                speechRecognizer?.setRecognitionListener(AriaRecognitionListener())
            } catch (e: Exception) {
                Log.e(tag, "Error creating SpeechRecognizer: ${e.message}")
            }
        }
    }

    fun startListening() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.w(tag, "startListening ignored: RECORD_AUDIO permission not granted")
            isListening = false
            return
        }

        if (isListening) return
        mainHandler.post {
            try {
                if (speechRecognizer == null) {
                    initializeSpeechRecognizer()
                }
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toString())
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                }
                speechRecognizer?.startListening(intent)
                isListening = true
                Log.d(tag, "Speech recognition started")
            } catch (e: Exception) {
                Log.e(tag, "startListening error: ${e.message}")
                isListening = false
            }
        }
    }

    fun stopListening() {
        mainHandler.post {
            try {
                speechRecognizer?.stopListening()
                isListening = false
            } catch (e: Exception) {
                Log.w(tag, "stopListening error: ${e.message}")
            }
        }
    }

    fun restartListening() {
        stopListening()
        mainHandler.postDelayed({
            startListening()
        }, 300)
    }

    fun setAvatarState(newState: AvatarState) {
        _avatarState.value = newState
        onStateChanged?.invoke(newState)
    }

    private fun handleSpokenText(spoken: String) {
        if (isSpeaking.value) {
            // Drop input to avoid hearing own voice
            return
        }

        val clean = spoken.trim().lowercase(Locale.ROOT)
        _lastRecognizedText.value = spoken
        Log.d(tag, "Recognized: '$spoken' (Current state: ${_avatarState.value})")

        // Immediate stop command check
        if (fuzzyMatch(clean, "aria stop") || fuzzyMatch(clean, "stop aria") || clean == "stop" || clean == "cancel") {
            speak("Stopping right now!", AriaEmotion.SURPRISED)
            setAvatarState(AvatarState.LISTENING)
            resetSilenceTimer()
            return
        }

        if (_avatarState.value == AvatarState.SLEEPING) {
            val wakePhrase = prefs.wakePhrase.lowercase(Locale.ROOT)
            val assistantName = prefs.assistantName.lowercase(Locale.ROOT)

            if (fuzzyMatch(clean, wakePhrase) || clean.contains(assistantName) || clean.contains("hey aria") || clean.contains("wake up")) {
                wakeUp()
            }
        } else {
            // ACTIVE states
            val sleepPhrase = prefs.sleepPhrase.lowercase(Locale.ROOT)
            if (fuzzyMatch(clean, sleepPhrase) || clean.contains("go to sleep") || clean.contains("goodnight")) {
                goToSleep("Going to sleep now! Night-night!")
                return
            }

            resetSilenceTimer()
            if (clean.isNotBlank()) {
                onCommandReceived?.invoke(spoken)
            }
        }
    }

    fun wakeUp() {
        setAvatarState(AvatarState.LISTENING)
        speak("I'm here!", AriaEmotion.EXCITED)
        resetSilenceTimer()
    }

    fun goToSleep(farewell: String = "Going to sleep now!") {
        cancelSilenceTimer()
        speak(farewell, AriaEmotion.SLEEPY) {
            setAvatarState(AvatarState.SLEEPING)
        }
    }

    private fun resetSilenceTimer() {
        cancelSilenceTimer()
        val timeoutMs = prefs.silenceTimeoutSeconds * 1000L
        silenceRunnable = Runnable {
            if (_avatarState.value == AvatarState.LISTENING && !isSpeaking.value) {
                Log.d(tag, "Silence timeout reached, returning to sleep")
                setAvatarState(AvatarState.SLEEPING)
            }
        }
        silenceRunnable?.let { mainHandler.postDelayed(it, timeoutMs) }
    }

    private fun cancelSilenceTimer() {
        silenceRunnable?.let { mainHandler.removeCallbacks(it) }
        silenceRunnable = null
    }

    // --- Fuzzy Matching ---
    fun fuzzyMatch(spoken: String, target: String): Boolean {
        if (spoken.isEmpty() || target.isEmpty()) return false
        val s = spoken.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9 ]"), "").trim()
        val t = target.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9 ]"), "").trim()

        if (s == t || s.contains(t) || t.contains(s)) return true

        val sWords = s.split(" ")
        val tWords = t.split(" ")
        val commonWords = sWords.filter { it in tWords }
        if (commonWords.size >= max(1, tWords.size / 2)) return true

        val distance = levenshteinDistance(s, t)
        val maxLen = max(s.length, t.length)
        val similarity = 1.0 - (distance.toDouble() / maxLen.toDouble())
        return similarity >= 0.70
    }

    private fun levenshteinDistance(s1: String, s2: String): Int {
        val dp = Array(s1.length + 1) { IntArray(s2.length + 1) }
        for (i in 0..s1.length) dp[i][0] = i
        for (j in 0..s2.length) dp[0][j] = j

        for (i in 1..s1.length) {
            for (j in 1..s2.length) {
                val cost = if (s1[i - 1] == s2[j - 1]) 0 else 1
                dp[i][j] = minOf(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost
                )
            }
        }
        return dp[s1.length][s2.length]
    }

    fun destroy() {
        cancelSilenceTimer()
        stopListening()
        speechRecognizer?.destroy()
        ttsManager.destroy()
    }

    private inner class AriaRecognitionListener : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {
            cancelSilenceTimer()
        }
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}

        override fun onError(error: Int) {
            Log.w(tag, "Speech recognition error code: $error")
            isListening = false

            when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                    Log.w(tag, "Microphone permission missing; stopping listener until granted")
                }
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_CLIENT -> {
                    mainHandler.postDelayed({
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            try {
                                speechRecognizer?.destroy()
                                speechRecognizer = null
                                initializeSpeechRecognizer()
                                startListening()
                            } catch (e: Exception) {
                                Log.e(tag, "Re-init error: ${e.message}")
                            }
                        }
                    }, 3500)
                }
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                    mainHandler.postDelayed({
                        startListening()
                    }, 400)
                }
                else -> {
                    mainHandler.postDelayed({
                        startListening()
                    }, 1500)
                }
            }
        }

        override fun onResults(results: Bundle?) {
            val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            if (!matches.isNullOrEmpty()) {
                handleSpokenText(matches[0])
            }
            mainHandler.postDelayed({
                if (isListening) startListening()
            }, 200)
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            if (!matches.isNullOrEmpty()) {
                val partial = matches[0]
                if (_avatarState.value == AvatarState.SLEEPING) {
                    handleSpokenText(partial)
                }
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }
}
