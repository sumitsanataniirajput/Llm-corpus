package com.example.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.example.data.AriaPreferences
import com.example.model.AriaEmotion
import com.example.model.EmotionalSentence
import com.example.model.TTSProviderType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class AriaTTSManager(
    private val context: Context,
    private val prefs: AriaPreferences
) {
    private val tag = "AriaTTSManager"
    private val scope = CoroutineScope(Dispatchers.Main)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .build()

    // State flows
    private val _currentEmotion = MutableStateFlow(AriaEmotion.NEUTRAL)
    val currentEmotion: StateFlow<AriaEmotion> = _currentEmotion.asStateFlow()

    private val _isSpeaking = MutableStateFlow(false)
    val isSpeaking: StateFlow<Boolean> = _isSpeaking.asStateFlow()

    private val _audioAmplitude = MutableStateFlow(0f)
    val audioAmplitude: StateFlow<Float> = _audioAmplitude.asStateFlow()

    var onSpeechBubbleText: ((String) -> Unit)? = null

    // Fallback Android TTS
    private var androidTts: TextToSpeech? = null
    private var isAndroidTtsReady = false

    // Media Player for cloud audio
    private var mediaPlayer: MediaPlayer? = null
    private var amplitudeJob: Job? = null
    private val audioCache = ConcurrentHashMap<String, File>()

    init {
        initializeAndroidTTS()
        initAudioCacheDir()
    }

    private fun initAudioCacheDir() {
        try {
            val cacheDir = File(context.cacheDir, "aria_tts_cache")
            if (!cacheDir.exists()) cacheDir.mkdirs()
            cacheDir.listFiles()?.forEach { file ->
                audioCache[file.nameWithoutExtension] = file
            }
        } catch (e: Exception) {
            Log.w(tag, "Cache dir init error: ${e.message}")
        }
    }

    private fun initializeAndroidTTS() {
        androidTts = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                isAndroidTtsReady = true
                androidTts?.language = Locale.US
                applyAndroidVoiceSettings()
            }
        }

        androidTts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                _isSpeaking.value = true
                startSimulatedAmplitude()
            }

            override fun onDone(utteranceId: String?) {
                stopAmplitude()
                _isSpeaking.value = false
            }

            override fun onError(utteranceId: String?) {
                stopAmplitude()
                _isSpeaking.value = false
            }
        })
    }

    fun applyAndroidVoiceSettings() {
        val config = prefs.loadTTSConfig()
        androidTts?.setPitch(config.pitch)
        androidTts?.setSpeechRate(config.speed)

        if (prefs.ttsVoiceName.isNotBlank()) {
            androidTts?.voices?.find { it.name == prefs.ttsVoiceName }?.let {
                androidTts?.voice = it
            }
        }
    }

    /**
     * Speaks a list of emotional sentences, streaming sentence by sentence.
     */
    fun speakSentences(sentences: List<EmotionalSentence>, onAllComplete: (() -> Unit)? = null) {
        if (sentences.isEmpty()) {
            onAllComplete?.invoke()
            return
        }

        scope.launch {
            for (sentence in sentences) {
                _currentEmotion.value = sentence.emotion
                onSpeechBubbleText?.invoke(sentence.text)
                speakSingleSentence(sentence)
            }
            _currentEmotion.value = AriaEmotion.NEUTRAL
            onAllComplete?.invoke()
        }
    }

    fun speakEmotionalSentences(sentences: List<EmotionalSentence>, onAllComplete: (() -> Unit)? = null) =
        speakSentences(sentences, onAllComplete)

    fun speakText(text: String, emotion: AriaEmotion = AriaEmotion.HAPPY, onDone: (() -> Unit)? = null) {
        val sentence = EmotionalSentence(text = text, emotion = emotion, intensity = 2)
        speakSentences(listOf(sentence), onDone)
    }

    private suspend fun speakSingleSentence(sentence: EmotionalSentence) = withContext(Dispatchers.Main) {
        val config = prefs.loadTTSConfig()
        val text = sentence.text.trim()
        if (text.isBlank()) return@withContext

        // 1. Check audio cache for frequent/repeated phrases
        val cacheKey = hashPhrase(text, config.activeProvider.name, sentence.emotion.name)
        val cachedFile = audioCache[cacheKey]
        if (cachedFile != null && cachedFile.exists() && cachedFile.length() > 0) {
            playAudioFile(cachedFile)
            return@withContext
        }

        // 2. Synthesize using active TTS provider
        var played = false
        when (config.activeProvider) {
            TTSProviderType.ELEVENLABS -> {
                if (config.elevenLabsApiKey.isNotBlank()) {
                    val audioFile = fetchElevenLabsAudio(text, sentence, config, cacheKey)
                    if (audioFile != null) {
                        playAudioFile(audioFile)
                        played = true
                    }
                }
            }
            TTSProviderType.OPENAI_TTS -> {
                if (config.openAIApiKey.isNotBlank()) {
                    val audioFile = fetchOpenAIAudio(text, sentence, config, cacheKey)
                    if (audioFile != null) {
                        playAudioFile(audioFile)
                        played = true
                    }
                }
            }
            TTSProviderType.GEMINI_TTS -> {
                // Gemini TTS style or fallback to Android TTS with expressive modulation
                played = false
            }
            TTSProviderType.ANDROID_TTS -> {
                // handled by fallback below
            }
        }

        // 3. Fallback to Android TTS with dynamic pitch/speed emotion styling
        if (!played) {
            speakWithAndroidTTS(sentence)
        }
    }

    private suspend fun speakWithAndroidTTS(sentence: EmotionalSentence) = withContext(Dispatchers.Main) {
        val baseConfig = prefs.loadTTSConfig()
        var pitch = baseConfig.pitch
        var speed = baseConfig.speed

        // Dynamic childlike emotion modulation on pitch & speed
        when (sentence.emotion) {
            AriaEmotion.EXCITED -> { pitch *= 1.25f; speed *= 1.15f }
            AriaEmotion.HAPPY -> { pitch *= 1.15f; speed *= 1.05f }
            AriaEmotion.SHY -> { pitch *= 1.05f; speed *= 0.88f }
            AriaEmotion.SAD -> { pitch *= 0.88f; speed *= 0.82f }
            AriaEmotion.ANGRY -> { pitch *= 1.08f; speed *= 1.18f }
            AriaEmotion.ANNOYED -> { pitch *= 1.00f; speed *= 1.10f }
            AriaEmotion.SURPRISED -> { pitch *= 1.30f; speed *= 1.10f }
            AriaEmotion.SCARED -> { pitch *= 1.25f; speed *= 1.00f }
            AriaEmotion.CURIOUS -> { pitch *= 1.18f; speed *= 1.00f }
            AriaEmotion.SLEEPY -> { pitch *= 0.88f; speed *= 0.78f }
            AriaEmotion.PROUD -> { pitch *= 1.16f; speed *= 1.05f }
            AriaEmotion.NEUTRAL -> {}
        }

        androidTts?.setPitch(pitch)
        androidTts?.setSpeechRate(speed)

        val utteranceId = UUID.randomUUID().toString()
        val params = Bundle()
        params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)

        val completable = kotlinx.coroutines.CompletableDeferred<Unit>()
        androidTts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {
                _isSpeaking.value = true
                startSimulatedAmplitude()
            }
            override fun onDone(id: String?) {
                stopAmplitude()
                _isSpeaking.value = false
                completable.complete(Unit)
            }
            override fun onError(id: String?) {
                stopAmplitude()
                _isSpeaking.value = false
                completable.complete(Unit)
            }
        })

        androidTts?.speak(sentence.text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        completable.await()
    }

    // --- ElevenLabs API ---
    private suspend fun fetchElevenLabsAudio(
        text: String,
        sentence: EmotionalSentence,
        config: com.example.model.TTSConfig,
        cacheKey: String
    ): File? = withContext(Dispatchers.IO) {
        try {
            val voiceId = config.elevenLabsVoiceId.ifBlank { "21m00Tcm4TlvDq8ikWAM" }
            val url = "https://api.elevenlabs.io/v1/text-to-speech/$voiceId"

            val bodyJson = JSONObject()
            bodyJson.put("text", text)
            bodyJson.put("model_id", "eleven_multilingual_v2")

            val voiceSettings = JSONObject()
            val styleScore = when (sentence.emotion) {
                AriaEmotion.EXCITED, AriaEmotion.HAPPY -> 0.65
                AriaEmotion.SHY -> 0.35
                AriaEmotion.SAD -> 0.25
                else -> 0.45
            }
            voiceSettings.put("stability", 0.45)
            voiceSettings.put("similarity_boost", 0.85)
            voiceSettings.put("style", styleScore)
            bodyJson.put("voice_settings", voiceSettings)

            val request = Request.Builder()
                .url(url)
                .addHeader("xi-api-key", config.elevenLabsApiKey)
                .addHeader("Content-Type", "application/json")
                .post(bodyJson.toString().toRequestBody("application/json".toMediaType()))
                .build()

            val response = httpClient.newCall(request).execute()
            if (!response.isSuccessful) return@withContext null

            val bytes = response.body?.bytes() ?: return@withContext null
            val file = File(context.cacheDir, "aria_tts_cache/$cacheKey.mp3")
            FileOutputStream(file).use { it.write(bytes) }
            audioCache[cacheKey] = file
            file
        } catch (e: Exception) {
            Log.w(tag, "ElevenLabs TTS error: ${e.message}")
            null
        }
    }

    // --- OpenAI TTS API ---
    private suspend fun fetchOpenAIAudio(
        text: String,
        sentence: EmotionalSentence,
        config: com.example.model.TTSConfig,
        cacheKey: String
    ): File? = withContext(Dispatchers.IO) {
        try {
            val url = "https://api.openai.com/v1/audio/speech"
            val body = JSONObject()
            body.put("model", "tts-1")
            body.put("input", text)
            body.put("voice", config.openAIVoice.ifBlank { "nova" })
            val speed = when (sentence.emotion) {
                AriaEmotion.EXCITED -> 1.15
                AriaEmotion.SLEEPY, AriaEmotion.SAD -> 0.88
                else -> 1.0
            }
            body.put("speed", speed)

            val request = Request.Builder()
                .url(url)
                .addHeader("Authorization", "Bearer ${config.openAIApiKey}")
                .addHeader("Content-Type", "application/json")
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()

            val response = httpClient.newCall(request).execute()
            if (!response.isSuccessful) return@withContext null

            val bytes = response.body?.bytes() ?: return@withContext null
            val file = File(context.cacheDir, "aria_tts_cache/$cacheKey.mp3")
            FileOutputStream(file).use { it.write(bytes) }
            audioCache[cacheKey] = file
            file
        } catch (e: Exception) {
            Log.w(tag, "OpenAI TTS error: ${e.message}")
            null
        }
    }

    private suspend fun playAudioFile(file: File) = withContext(Dispatchers.Main) {
        val completable = kotlinx.coroutines.CompletableDeferred<Unit>()
        try {
            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .build()
                )
                setDataSource(file.absolutePath)
                setOnPreparedListener {
                    _isSpeaking.value = true
                    startSimulatedAmplitude()
                    it.start()
                }
                setOnCompletionListener {
                    stopAmplitude()
                    _isSpeaking.value = false
                    completable.complete(Unit)
                }
                setOnErrorListener { _, _, _ ->
                    stopAmplitude()
                    _isSpeaking.value = false
                    completable.complete(Unit)
                    true
                }
                prepareAsync()
            }
            completable.await()
        } catch (e: Exception) {
            stopAmplitude()
            _isSpeaking.value = false
        }
    }

    private fun startSimulatedAmplitude() {
        amplitudeJob?.cancel()
        amplitudeJob = scope.launch {
            var phase = 0f
            while (_isSpeaking.value) {
                phase += 0.35f
                val amp = (kotlin.math.sin(phase) + 1f) / 2f * 0.8f + 0.2f
                _audioAmplitude.value = amp
                kotlinx.coroutines.delay(80)
            }
            _audioAmplitude.value = 0f
        }
    }

    private fun stopAmplitude() {
        amplitudeJob?.cancel()
        _audioAmplitude.value = 0f
    }

    fun stop() {
        mediaPlayer?.stop()
        mediaPlayer?.release()
        mediaPlayer = null
        androidTts?.stop()
        stopAmplitude()
        _isSpeaking.value = false
    }

    fun destroy() {
        stop()
        androidTts?.shutdown()
    }

    private fun hashPhrase(text: String, provider: String, emotion: String): String {
        val md = MessageDigest.getInstance("MD5")
        val input = "$text-$provider-$emotion"
        val bytes = md.digest(input.toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
