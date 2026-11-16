package com.example.model

enum class AvatarState {
    SLEEPING,  // Dimmed, quietly waiting for wake phrase
    LISTENING, // Glowing cyan/purple, listening to user command
    THINKING,  // Amber glow, querying brain / reasoning
    SPEAKING,  // Violet glow, mouth animation sync with TTS
    WORKING    // Emerald glow, actively controlling phone / executing task
}

enum class AriaEmotion(val label: String, val colorHex: Long) {
    HAPPY("happy", 0xFFFF4D8D),
    EXCITED("excited", 0xFFFF2E88),
    SHY("shy", 0xFFFF8FB8),
    SAD("sad", 0xFF64B5F6),
    ANGRY("angry", 0xFFE5214F),
    ANNOYED("annoyed", 0xFFFF5C5C),
    SURPRISED("surprised", 0xFF4DD0E1),
    SCARED("scared", 0xFFBA68C8),
    CURIOUS("curious", 0xFF81C784),
    SLEEPY("sleepy", 0xFFB59AAA),
    PROUD("proud", 0xFFFFB74D),
    NEUTRAL("neutral", 0xFFF7EAF0);

    companion object {
        fun fromString(value: String): AriaEmotion {
            val clean = value.trim().lowercase()
            return entries.find { it.label.equals(clean, ignoreCase = true) } ?: NEUTRAL
        }
    }
}

data class EmotionalSentence(
    val text: String,
    val emotion: AriaEmotion = AriaEmotion.NEUTRAL,
    val intensity: Int = 1, // 1 to 3
    val effect: String = "none", // laugh, sigh, pause_short, pause_long, none
    val stylePrompt: String = ""
)

enum class ProviderType(val displayName: String, val defaultBaseUrl: String) {
    OPENAI_COMPATIBLE("OpenAI-Compatible", "https://openrouter.ai/api/v1"),
    ANTHROPIC("Anthropic", "https://api.anthropic.com/v1"),
    GEMINI("Gemini", "https://generativelanguage.googleapis.com/v1beta")
}

data class AriaModel(
    val id: String,
    val nickname: String = "",
    val supportsImages: Boolean = false,
    val isActive: Boolean = false
) {
    val displayName: String
        get() = if (nickname.isNotBlank()) nickname else id
}

data class LLMProvider(
    val id: String,
    val nickname: String,
    val type: ProviderType,
    val baseUrl: String,
    val apiKey: String = "",
    val models: List<AriaModel> = emptyList(),
    val isActive: Boolean = false
)

enum class TTSProviderType(val displayName: String) {
    ANDROID_TTS("Android TTS (Offline Fallback)"),
    ELEVENLABS("ElevenLabs (Emotional Voice)"),
    OPENAI_TTS("OpenAI TTS"),
    GEMINI_TTS("Gemini Speech / TTS")
}

data class TTSConfig(
    val activeProvider: TTSProviderType = TTSProviderType.ANDROID_TTS,
    val elevenLabsApiKey: String = "",
    val elevenLabsVoiceId: String = "21m00Tcm4TlvDq8ikWAM", // Default friendly female voice
    val openAIApiKey: String = "",
    val openAIVoice: String = "nova", // nova is bright & youthful
    val geminiApiKey: String = "",
    val geminiVoiceName: String = "Puck",
    val voiceStyleDescription: String = "a young, bright, cheerful childlike girl voice",
    val pitch: Float = 1.15f,
    val speed: Float = 1.05f
)

data class ActionHistoryItem(
    val id: String,
    val timestamp: Long = System.currentTimeMillis(),
    val actionType: String,
    val description: String,
    val status: String = "SUCCESS", // SUCCESS, CONFIRMATION_REQUIRED, REFUSED_SAFETY, FAILED
    val details: String = ""
)

data class MemoryItem(
    val id: String,
    val fact: String,
    val timestamp: Long = System.currentTimeMillis()
)

data class ChatMessage(
    val id: String = java.util.UUID.randomUUID().toString(),
    val sender: String, // "USER" or "ARIA"
    val text: String,
    val emotion: AriaEmotion = AriaEmotion.HAPPY,
    val timestamp: Long = System.currentTimeMillis()
)
