package com.example.brain

import com.example.data.AriaPreferences

/**
 * OpenRouterClient delegates to UnifiedLLMClient for multi-provider support
 * (OpenAI-compatible, Anthropic, Gemini) and silent multi-model fallback.
 */
class OpenRouterClient(private val prefs: AriaPreferences) {
    private val unified = UnifiedLLMClient(prefs)

    suspend fun query(
        userMessage: String,
        screenContext: String? = null,
        screenshotBase64: String? = null,
        history: List<Pair<String, String>> = emptyList(),
        enableTools: Boolean = true
    ): BrainResponse {
        return unified.query(userMessage, screenContext, screenshotBase64, history, enableTools)
    }
}
