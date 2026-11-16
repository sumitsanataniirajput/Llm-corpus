package com.example.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.example.model.ActionHistoryItem
import com.example.model.AriaModel
import com.example.model.LLMProvider
import com.example.model.MemoryItem
import com.example.model.ProviderType
import com.example.model.TTSConfig
import com.example.model.TTSProviderType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class AriaPreferences(private val context: Context) {

    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "aria_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        Log.w("AriaPreferences", "Fallback to private SharedPreferences: ${e.message}")
        context.getSharedPreferences("aria_fallback_prefs", Context.MODE_PRIVATE)
    }

    private val _providersState = MutableStateFlow<List<LLMProvider>>(emptyList())
    val providersState: StateFlow<List<LLMProvider>> = _providersState.asStateFlow()

    private val _ttsConfigState = MutableStateFlow(loadTTSConfig())
    val ttsConfigState: StateFlow<TTSConfig> = _ttsConfigState.asStateFlow()

    private val _ignoredAppsState = MutableStateFlow<List<String>>(emptyList())
    val ignoredAppsState: StateFlow<List<String>> = _ignoredAppsState.asStateFlow()

    private val _historyState = MutableStateFlow<List<ActionHistoryItem>>(emptyList())
    val historyState: StateFlow<List<ActionHistoryItem>> = _historyState.asStateFlow()

    private val _memoriesState = MutableStateFlow<List<MemoryItem>>(emptyList())
    val memoriesState: StateFlow<List<MemoryItem>> = _memoriesState.asStateFlow()

    private val _chatMessagesState = MutableStateFlow<List<com.example.model.ChatMessage>>(emptyList())
    val chatMessagesState: StateFlow<List<com.example.model.ChatMessage>> = _chatMessagesState.asStateFlow()

    init {
        _providersState.value = loadProviders()
        _ignoredAppsState.value = loadIgnoredApps()
        _historyState.value = loadHistory()
        _memoriesState.value = loadMemories()
        _chatMessagesState.value = loadChatMessages()
    }

    // --- Appearance & System Preferences ---
    var isDarkMode: Boolean
        get() = prefs.getBoolean(KEY_IS_DARK_MODE, true)
        set(value) = prefs.edit().putBoolean(KEY_IS_DARK_MODE, value).apply()

    var reduceAnimations: Boolean
        get() = prefs.getBoolean(KEY_REDUCE_ANIMATIONS, false)
        set(value) = prefs.edit().putBoolean(KEY_REDUCE_ANIMATIONS, value).apply()

    var hasCompletedOnboarding: Boolean
        get() = prefs.getBoolean(KEY_HAS_COMPLETED_ONBOARDING, false)
        set(value) = prefs.edit().putBoolean(KEY_HAS_COMPLETED_ONBOARDING, value).apply()

    // --- Floating Avatar Overlay Preferences ---
    var overlaySizeDp: Int
        get() = prefs.getInt(KEY_OVERLAY_SIZE_DP, 96)
        set(value) = prefs.edit().putInt(KEY_OVERLAY_SIZE_DP, value.coerceIn(64, 140)).apply()

    var overlayOpacityPercent: Int
        get() = prefs.getInt(KEY_OVERLAY_OPACITY, 100)
        set(value) = prefs.edit().putInt(KEY_OVERLAY_OPACITY, value.coerceIn(40, 100)).apply()

    var overlayShowGlowRing: Boolean
        get() = prefs.getBoolean(KEY_OVERLAY_SHOW_GLOW_RING, true)
        set(value) = prefs.edit().putBoolean(KEY_OVERLAY_SHOW_GLOW_RING, value).apply()

    var customAvatarUri: String?
        get() = prefs.getString(KEY_CUSTOM_AVATAR_URI, null)
        set(value) = prefs.edit().putString(KEY_CUSTOM_AVATAR_URI, value).apply()

    var freeMovementEnabled: Boolean
        get() = prefs.getBoolean(KEY_FREE_MOVEMENT_ENABLED, true)
        set(value) = prefs.edit().putBoolean(KEY_FREE_MOVEMENT_ENABLED, value).apply()

    // --- Chat Messages Persistence ---
    fun loadChatMessages(): List<com.example.model.ChatMessage> {
        val raw = prefs.getString(KEY_CHAT_MESSAGES_JSON, null) ?: return listOf(
            com.example.model.ChatMessage(
                sender = "ARIA",
                text = "Hi there! I'm Aria, your floating companion. How can I help you today?",
                emotion = com.example.model.AriaEmotion.HAPPY
            )
        )
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<com.example.model.ChatMessage>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                list.add(
                    com.example.model.ChatMessage(
                        id = obj.getString("id"),
                        sender = obj.getString("sender"),
                        text = obj.getString("text"),
                        emotion = com.example.model.AriaEmotion.fromString(obj.optString("emotion", "happy")),
                        timestamp = obj.getLong("timestamp")
                    )
                )
            }
            list
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun addChatMessage(sender: String, text: String, emotion: com.example.model.AriaEmotion = com.example.model.AriaEmotion.HAPPY) {
        val current = _chatMessagesState.value.toMutableList()
        current.add(
            com.example.model.ChatMessage(
                sender = sender,
                text = text,
                emotion = emotion
            )
        )
        // Keep last 100 messages
        val trimmed = if (current.size > 100) current.takeLast(100) else current
        val arr = JSONArray()
        for (m in trimmed) {
            val obj = JSONObject()
            obj.put("id", m.id)
            obj.put("sender", m.sender)
            obj.put("text", m.text)
            obj.put("emotion", m.emotion.label)
            obj.put("timestamp", m.timestamp)
            arr.put(obj)
        }
        prefs.edit().putString(KEY_CHAT_MESSAGES_JSON, arr.toString()).apply()
        _chatMessagesState.value = trimmed
    }

    fun clearChatMessages() {
        prefs.edit().remove(KEY_CHAT_MESSAGES_JSON).apply()
        _chatMessagesState.value = emptyList()
    }

    // --- Core Assistant Settings ---
    var assistantName: String
        get() = prefs.getString(KEY_ASSISTANT_NAME, "Aria") ?: "Aria"
        set(value) = prefs.edit().putString(KEY_ASSISTANT_NAME, value.trim()).apply()

    var wakePhrase: String
        get() = prefs.getString(KEY_WAKE_PHRASE, "Hey Aria") ?: "Hey Aria"
        set(value) = prefs.edit().putString(KEY_WAKE_PHRASE, value.trim()).apply()

    var sleepPhrase: String
        get() = prefs.getString(KEY_SLEEP_PHRASE, "Aria, go to sleep") ?: "Aria, go to sleep"
        set(value) = prefs.edit().putString(KEY_SLEEP_PHRASE, value.trim()).apply()

    var silenceTimeoutSeconds: Int
        get() = prefs.getInt(KEY_SILENCE_TIMEOUT, 5)
        set(value) = prefs.edit().putInt(KEY_SILENCE_TIMEOUT, value.coerceIn(2, 30)).apply()

    var startOnBoot: Boolean
        get() = prefs.getBoolean(KEY_START_ON_BOOT, false)
        set(value) = prefs.edit().putBoolean(KEY_START_ON_BOOT, value).apply()

    // --- Always-on Screen Awareness ---
    var screenAwarenessEnabled: Boolean
        get() = prefs.getBoolean(KEY_SCREEN_AWARENESS_ENABLED, true)
        set(value) = prefs.edit().putBoolean(KEY_SCREEN_AWARENESS_ENABLED, value).apply()

    var minBatteryThreshold: Int
        get() = prefs.getInt(KEY_MIN_BATTERY_THRESHOLD, 15)
        set(value) = prefs.edit().putInt(KEY_MIN_BATTERY_THRESHOLD, value.coerceIn(5, 50)).apply()

    fun loadIgnoredApps(): List<String> {
        val raw = prefs.getString(KEY_IGNORED_APPS_JSON, null) ?: return listOf(
            "com.android.settings", "com.google.android.apps.messaging"
        )
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<String>()
            for (i in 0 until arr.length()) list.add(arr.getString(i))
            list
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun addIgnoredApp(pkgOrName: String) {
        val trimmed = pkgOrName.trim()
        if (trimmed.isBlank()) return
        val current = loadIgnoredApps().toMutableList()
        if (!current.contains(trimmed)) {
            current.add(trimmed)
            val arr = JSONArray(current)
            prefs.edit().putString(KEY_IGNORED_APPS_JSON, arr.toString()).apply()
            _ignoredAppsState.value = current
        }
    }

    fun removeIgnoredApp(pkgOrName: String) {
        val current = loadIgnoredApps().filterNot { it.equals(pkgOrName, ignoreCase = true) }
        val arr = JSONArray(current)
        prefs.edit().putString(KEY_IGNORED_APPS_JSON, arr.toString()).apply()
        _ignoredAppsState.value = current
    }

    // --- Multi-Provider Management ---
    fun loadProviders(): List<LLMProvider> {
        val raw = prefs.getString(KEY_PROVIDERS_JSON, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<LLMProvider>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val modelsArr = obj.optJSONArray("models") ?: JSONArray()
                val modelsList = mutableListOf<AriaModel>()
                for (j in 0 until modelsArr.length()) {
                    val mObj = modelsArr.getJSONObject(j)
                    modelsList.add(
                        AriaModel(
                            id = mObj.getString("id"),
                            nickname = mObj.optString("nickname", ""),
                            supportsImages = mObj.optBoolean("supportsImages", false),
                            isActive = mObj.optBoolean("isActive", false)
                        )
                    )
                }
                val typeStr = obj.optString("type", ProviderType.OPENAI_COMPATIBLE.name)
                val type = try { ProviderType.valueOf(typeStr) } catch (e: Exception) { ProviderType.OPENAI_COMPATIBLE }

                list.add(
                    LLMProvider(
                        id = obj.getString("id"),
                        nickname = obj.optString("nickname", "Provider"),
                        type = type,
                        baseUrl = obj.optString("baseUrl", type.defaultBaseUrl),
                        apiKey = obj.optString("apiKey", ""),
                        models = modelsList,
                        isActive = obj.optBoolean("isActive", false)
                    )
                )
            }
            list
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun saveProviders(providers: List<LLMProvider>) {
        val arr = JSONArray()
        for (p in providers) {
            val obj = JSONObject()
            obj.put("id", p.id)
            obj.put("nickname", p.nickname)
            obj.put("type", p.type.name)
            obj.put("baseUrl", p.baseUrl)
            obj.put("apiKey", p.apiKey)
            obj.put("isActive", p.isActive)

            val mArr = JSONArray()
            for (m in p.models) {
                val mObj = JSONObject()
                mObj.put("id", m.id)
                mObj.put("nickname", m.nickname)
                mObj.put("supportsImages", m.supportsImages)
                mObj.put("isActive", m.isActive)
                mArr.put(mObj)
            }
            obj.put("models", mArr)
            arr.put(obj)
        }
        prefs.edit().putString(KEY_PROVIDERS_JSON, arr.toString()).apply()
        _providersState.value = providers
    }

    fun addProvider(
        nickname: String,
        type: ProviderType,
        baseUrl: String,
        apiKey: String,
        initialModels: List<AriaModel> = emptyList()
    ): LLMProvider {
        val current = loadProviders().toMutableList()
        val isFirst = current.isEmpty()
        val provider = LLMProvider(
            id = UUID.randomUUID().toString(),
            nickname = nickname.trim().ifBlank { type.displayName },
            type = type,
            baseUrl = baseUrl.trim().ifBlank { type.defaultBaseUrl },
            apiKey = apiKey.trim(),
            models = initialModels,
            isActive = isFirst
        )
        current.add(provider)
        saveProviders(current)
        return provider
    }

    fun updateProvider(updated: LLMProvider) {
        val current = loadProviders().map {
            if (it.id == updated.id) updated else it
        }
        saveProviders(current)
    }

    fun removeProvider(id: String) {
        val current = loadProviders().toMutableList()
        val removed = current.find { it.id == id }
        current.removeAll { it.id == id }
        if (removed?.isActive == true && current.isNotEmpty()) {
            current[0] = current[0].copy(isActive = true)
        }
        saveProviders(current)
    }

    fun setActiveProvider(providerId: String) {
        val current = loadProviders().map {
            it.copy(isActive = it.id == providerId)
        }
        saveProviders(current)
    }

    fun setActiveModelInProvider(providerId: String, modelId: String) {
        val current = loadProviders().map { provider ->
            if (provider.id == providerId) {
                val updatedModels = provider.models.map {
                    it.copy(isActive = it.id == modelId)
                }
                provider.copy(isActive = true, models = updatedModels)
            } else {
                provider.copy(isActive = false)
            }
        }
        saveProviders(current)
    }

    fun addModelToProvider(providerId: String, modelId: String, nickname: String, supportsImages: Boolean) {
        val current = loadProviders().map { provider ->
            if (provider.id == providerId) {
                val models = provider.models.filterNot { it.id == modelId }.toMutableList()
                val isFirstModel = models.isEmpty()
                models.add(
                    AriaModel(
                        id = modelId.trim(),
                        nickname = nickname.trim(),
                        supportsImages = supportsImages,
                        isActive = isFirstModel
                    )
                )
                provider.copy(models = models)
            } else provider
        }
        saveProviders(current)
    }

    fun removeModelFromProvider(providerId: String, modelId: String) {
        val current = loadProviders().map { provider ->
            if (provider.id == providerId) {
                val models = provider.models.filterNot { it.id == modelId }.toMutableList()
                if (models.isNotEmpty() && models.none { it.isActive }) {
                    models[0] = models[0].copy(isActive = true)
                }
                provider.copy(models = models)
            } else provider
        }
        saveProviders(current)
    }

    fun getActiveProvider(): LLMProvider? {
        val list = loadProviders()
        return list.firstOrNull { it.isActive } ?: list.firstOrNull()
    }

    fun getActiveModel(): AriaModel? {
        val provider = getActiveProvider() ?: return null
        return provider.models.firstOrNull { it.isActive } ?: provider.models.firstOrNull()
    }

    // --- Legacy compatibility helpers for models screen / preferences ---
    val apiKey: String
        get() = getActiveProvider()?.apiKey ?: ""

    fun loadModels(): List<AriaModel> {
        val activeProvider = getActiveProvider()
        return activeProvider?.models ?: emptyList()
    }

    // --- TTS Configuration ---
    fun loadTTSConfig(): TTSConfig {
        val providerStr = prefs.getString(KEY_TTS_ACTIVE_PROVIDER, TTSProviderType.ANDROID_TTS.name)
        val providerType = try {
            TTSProviderType.valueOf(providerStr ?: TTSProviderType.ANDROID_TTS.name)
        } catch (e: Exception) {
            TTSProviderType.ANDROID_TTS
        }

        return TTSConfig(
            activeProvider = providerType,
            elevenLabsApiKey = prefs.getString(KEY_TTS_ELEVEN_KEY, "") ?: "",
            elevenLabsVoiceId = prefs.getString(KEY_TTS_ELEVEN_VOICE, "21m00Tcm4TlvDq8ikWAM") ?: "21m00Tcm4TlvDq8ikWAM",
            openAIApiKey = prefs.getString(KEY_TTS_OPENAI_KEY, "") ?: "",
            openAIVoice = prefs.getString(KEY_TTS_OPENAI_VOICE, "nova") ?: "nova",
            geminiApiKey = prefs.getString(KEY_TTS_GEMINI_KEY, "") ?: "",
            geminiVoiceName = prefs.getString(KEY_TTS_GEMINI_VOICE, "Puck") ?: "Puck",
            voiceStyleDescription = prefs.getString(KEY_TTS_STYLE_DESC, "a young, bright, cheerful childlike girl voice") ?: "a young, bright, cheerful childlike girl voice",
            pitch = prefs.getFloat(KEY_TTS_PITCH, 1.15f),
            speed = prefs.getFloat(KEY_TTS_RATE, 1.05f)
        )
    }

    fun saveTTSConfig(config: TTSConfig) {
        prefs.edit()
            .putString(KEY_TTS_ACTIVE_PROVIDER, config.activeProvider.name)
            .putString(KEY_TTS_ELEVEN_KEY, config.elevenLabsApiKey)
            .putString(KEY_TTS_ELEVEN_VOICE, config.elevenLabsVoiceId)
            .putString(KEY_TTS_OPENAI_KEY, config.openAIApiKey)
            .putString(KEY_TTS_OPENAI_VOICE, config.openAIVoice)
            .putString(KEY_TTS_GEMINI_KEY, config.geminiApiKey)
            .putString(KEY_TTS_GEMINI_VOICE, config.geminiVoiceName)
            .putString(KEY_TTS_STYLE_DESC, config.voiceStyleDescription)
            .putFloat(KEY_TTS_PITCH, config.pitch)
            .putFloat(KEY_TTS_RATE, config.speed)
            .apply()
        _ttsConfigState.value = config
    }

    fun updateTTSConfig(config: TTSConfig) = saveTTSConfig(config)

    var ttsVoiceName: String
        get() = prefs.getString(KEY_TTS_VOICE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_TTS_VOICE, value).apply()

    var ttsPitch: Float
        get() = _ttsConfigState.value.pitch
        set(value) = saveTTSConfig(_ttsConfigState.value.copy(pitch = value))

    var ttsRate: Float
        get() = _ttsConfigState.value.speed
        set(value) = saveTTSConfig(_ttsConfigState.value.copy(speed = value))

    // --- Action History ---
    fun addActionHistory(item: ActionHistoryItem) {
        val current = loadHistory().toMutableList()
        current.add(0, item)
        if (current.size > 200) current.removeAt(current.lastIndex)
        val array = JSONArray()
        for (h in current) {
            val obj = JSONObject()
            obj.put("id", h.id)
            obj.put("timestamp", h.timestamp)
            obj.put("actionType", h.actionType)
            obj.put("description", h.description)
            obj.put("status", h.status)
            obj.put("details", h.details)
            array.put(obj)
        }
        prefs.edit().putString(KEY_HISTORY_JSON, array.toString()).apply()
        _historyState.value = current
    }

    fun loadHistory(): List<ActionHistoryItem> {
        val raw = prefs.getString(KEY_HISTORY_JSON, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<ActionHistoryItem>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                list.add(
                    ActionHistoryItem(
                        id = obj.getString("id"),
                        timestamp = obj.getLong("timestamp"),
                        actionType = obj.getString("actionType"),
                        description = obj.getString("description"),
                        status = obj.optString("status", "SUCCESS"),
                        details = obj.optString("details", "")
                    )
                )
            }
            list
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun clearHistory() {
        prefs.edit().remove(KEY_HISTORY_JSON).apply()
        _historyState.value = emptyList()
    }

    // --- Long-term Memories ---
    fun addMemory(fact: String) {
        if (fact.isBlank()) return
        val current = loadMemories().toMutableList()
        current.add(0, MemoryItem(id = UUID.randomUUID().toString(), fact = fact.trim()))
        if (current.size > 50) current.removeAt(current.lastIndex)
        saveMemories(current)
    }

    fun removeMemory(id: String) {
        val current = loadMemories().filterNot { it.id == id }
        saveMemories(current)
    }

    private fun saveMemories(memories: List<MemoryItem>) {
        val arr = JSONArray()
        for (m in memories) {
            val obj = JSONObject()
            obj.put("id", m.id)
            obj.put("fact", m.fact)
            obj.put("timestamp", m.timestamp)
            arr.put(obj)
        }
        prefs.edit().putString(KEY_MEMORIES_JSON, arr.toString()).apply()
        _memoriesState.value = memories
    }

    fun loadMemories(): List<MemoryItem> {
        val raw = prefs.getString(KEY_MEMORIES_JSON, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<MemoryItem>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                list.add(
                    MemoryItem(
                        id = obj.getString("id"),
                        fact = obj.getString("fact"),
                        timestamp = obj.getLong("timestamp")
                    )
                )
            }
            list
        } catch (e: Exception) {
            emptyList()
        }
    }

    companion object {
        private const val KEY_ASSISTANT_NAME = "assistant_name"
        private const val KEY_WAKE_PHRASE = "wake_phrase"
        private const val KEY_SLEEP_PHRASE = "sleep_phrase"
        private const val KEY_SILENCE_TIMEOUT = "silence_timeout_sec"
        private const val KEY_START_ON_BOOT = "start_on_boot"
        private const val KEY_SCREEN_AWARENESS_ENABLED = "screen_awareness_enabled"
        private const val KEY_MIN_BATTERY_THRESHOLD = "min_battery_threshold"
        private const val KEY_IGNORED_APPS_JSON = "ignored_apps_json"
        private const val KEY_PROVIDERS_JSON = "providers_json"
        private const val KEY_HISTORY_JSON = "history_json"
        private const val KEY_MEMORIES_JSON = "memories_json"

        private const val KEY_TTS_ACTIVE_PROVIDER = "tts_active_provider"
        private const val KEY_TTS_ELEVEN_KEY = "tts_eleven_key"
        private const val KEY_TTS_ELEVEN_VOICE = "tts_eleven_voice"
        private const val KEY_TTS_OPENAI_KEY = "tts_openai_key"
        private const val KEY_TTS_OPENAI_VOICE = "tts_openai_voice"
        private const val KEY_TTS_GEMINI_KEY = "tts_gemini_key"
        private const val KEY_TTS_GEMINI_VOICE = "tts_gemini_voice"
        private const val KEY_TTS_STYLE_DESC = "tts_style_desc"
        private const val KEY_TTS_PITCH = "tts_pitch"
        private const val KEY_TTS_RATE = "tts_rate"
        private const val KEY_TTS_VOICE = "tts_voice_name"

        private const val KEY_IS_DARK_MODE = "is_dark_mode"
        private const val KEY_REDUCE_ANIMATIONS = "reduce_animations"
        private const val KEY_HAS_COMPLETED_ONBOARDING = "has_completed_onboarding"
        private const val KEY_OVERLAY_SIZE_DP = "overlay_size_dp"
        private const val KEY_OVERLAY_OPACITY = "overlay_opacity"
        private const val KEY_OVERLAY_SHOW_GLOW_RING = "overlay_show_glow_ring"
        private const val KEY_CUSTOM_AVATAR_URI = "custom_avatar_uri"
        private const val KEY_FREE_MOVEMENT_ENABLED = "free_movement_enabled"
        private const val KEY_CHAT_MESSAGES_JSON = "chat_messages_json"
    }
}
