package com.example.brain

import android.util.Log
import com.example.data.AriaPreferences
import com.example.model.AriaEmotion
import com.example.model.AriaModel
import com.example.model.EmotionalSentence
import com.example.model.LLMProvider
import com.example.model.ProviderType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class ToolCall(
    val id: String,
    val name: String,
    val argumentsJson: String
)

data class BrainResponse(
    val sentences: List<EmotionalSentence>,
    val toolCalls: List<ToolCall>,
    val rawText: String,
    val modelUsed: String?,
    val providerUsed: String?
)

class UnifiedLLMClient(private val prefs: AriaPreferences) {

    private val tag = "UnifiedLLMClient"
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun query(
        userMessage: String,
        screenContext: String? = null,
        screenshotBase64: String? = null,
        history: List<Pair<String, String>> = emptyList(),
        enableTools: Boolean = true
    ): BrainResponse = withContext(Dispatchers.IO) {
        val providers = prefs.loadProviders()
        if (providers.isEmpty()) {
            return@withContext defaultFallbackResponse("Hi! Please add a provider (OpenAI, Anthropic, or Gemini) in settings so I can talk!")
        }

        // Order providers: active provider first, then others
        val orderedProviders = mutableListOf<LLMProvider>()
        val activeProvider = providers.firstOrNull { it.isActive } ?: providers.first()
        orderedProviders.add(activeProvider)
        providers.filter { it.id != activeProvider.id }.forEach { orderedProviders.add(it) }

        for (provider in orderedProviders) {
            if (provider.apiKey.isBlank() || provider.models.isEmpty()) continue

            // Order models: active model first
            val orderedModels = mutableListOf<AriaModel>()
            val activeM = provider.models.firstOrNull { it.isActive } ?: provider.models.first()
            orderedModels.add(activeM)
            provider.models.filter { it.id != activeM.id }.forEach { orderedModels.add(it) }

            for (model in orderedModels) {
                try {
                    Log.d(tag, "Attempting ${provider.type} with model: ${model.id} (${provider.nickname})")
                    val response = when (provider.type) {
                        ProviderType.OPENAI_COMPATIBLE -> executeOpenAI(provider, model, userMessage, screenContext, screenshotBase64, history, enableTools)
                        ProviderType.ANTHROPIC -> executeAnthropic(provider, model, userMessage, screenContext, screenshotBase64, history, enableTools)
                        ProviderType.GEMINI -> executeGemini(provider, model, userMessage, screenContext, screenshotBase64, history, enableTools)
                    }

                    if (response != null && (response.sentences.isNotEmpty() || response.toolCalls.isNotEmpty())) {
                        return@withContext response
                    }
                } catch (e: Exception) {
                    Log.w(tag, "Model ${model.id} on ${provider.nickname} failed: ${e.message}. Silently falling back to next model.")
                }
            }
        }

        // Silent graceful fallback if all models / providers fail
        defaultFallbackResponse("Aww, my connection is feeling sleepy right now. Could you check my model or API key in settings?")
    }

    private fun getSystemPrompt(): String {
        val memories = prefs.loadMemories().joinToString("; ") { it.fact }
        val memoriesSection = if (memories.isNotBlank()) "\nThings you know about the user: $memories" else ""

        return """
You are ${prefs.assistantName}, a cheerful, curious, playful, childlike and wholesome little girl AI assistant!
Your personality:
- Short, simple sentences with a lively kid-like way of talking.
- Cheerful, curious, wholesome, and family-friendly.
- Absolutely NO romantic or sexual roleplay.
- Do NOT copy any existing character's catchphrases.
$memoriesSection

CRITICAL OUTPUT FORMAT:
You MUST respond with valid JSON containing a list of sentences, where EACH sentence has an emotion tag chosen from:
[happy, excited, shy, sad, angry, annoyed, surprised, scared, curious, sleepy, proud, neutral]
Also include intensity (1 to 3) and an optional effect: [laugh, sigh, pause_short, pause_long, none].
Choose emotions genuinely matching the context (praise makes you shy, fun ideas make you excited, scary news makes you scared, being ignored makes you sulky).

Format:
{
  "sentences": [
    {
      "text": "Yay, hello there!",
      "emotion": "excited",
      "intensity": 2,
      "effect": "laugh",
      "style_prompt": "say this with bouncy excitement like a happy child"
    }
  ]
}
If performing a phone task, you may also invoke available tools.
""".trimIndent()
    }

    // --- 1. OpenAI-Compatible Adapter ---
    private fun executeOpenAI(
        provider: LLMProvider,
        model: AriaModel,
        userMessage: String,
        screenContext: String?,
        screenshotBase64: String?,
        history: List<Pair<String, String>>,
        enableTools: Boolean
    ): BrainResponse? {
        val root = JSONObject()
        root.put("model", model.id)
        root.put("temperature", 0.7)

        val messages = JSONArray()

        val sysObj = JSONObject()
        sysObj.put("role", "system")
        sysObj.put("content", getSystemPrompt())
        messages.put(sysObj)

        for (h in history.takeLast(4)) {
            val hObj = JSONObject()
            hObj.put("role", h.first)
            hObj.put("content", h.second)
            messages.put(hObj)
        }

        val userObj = JSONObject()
        userObj.put("role", "user")

        val promptText = buildString {
            append(userMessage)
            if (!screenContext.isNullOrBlank()) {
                append("\n\n[Foreground Screen UI]:\n")
                append(screenContext.take(1500))
            }
        }

        if (model.supportsImages && screenshotBase64 != null) {
            val contentArr = JSONArray()
            val textPart = JSONObject()
            textPart.put("type", "text")
            textPart.put("text", promptText)
            contentArr.put(textPart)

            val imgPart = JSONObject()
            imgPart.put("type", "image_url")
            val imgUrl = JSONObject()
            imgUrl.put("url", "data:image/jpeg;base64,$screenshotBase64")
            imgPart.put("image_url", imgUrl)
            contentArr.put(imgPart)

            userObj.put("content", contentArr)
        } else {
            userObj.put("content", promptText)
        }
        messages.put(userObj)
        root.put("messages", messages)

        if (enableTools) {
            root.put("tools", buildOpenAITools())
            root.put("tool_choice", "auto")
        }

        val url = if (provider.baseUrl.endsWith("/chat/completions")) provider.baseUrl else "${provider.baseUrl.removeSuffix("/")}/chat/completions"

        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer ${provider.apiKey}")
            .addHeader("HTTP-Referer", "https://aria.assistant")
            .addHeader("X-Title", "Aria Voice Assistant")
            .post(root.toString().toRequestBody(jsonMediaType))
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body?.string() ?: return null
            val json = JSONObject(body)
            val choices = json.optJSONArray("choices") ?: return null
            if (choices.length() == 0) return null

            val first = choices.getJSONObject(0)
            val msg = first.optJSONObject("message") ?: return null
            val content = msg.optString("content", "")

            val toolCalls = mutableListOf<ToolCall>()
            val tcArr = msg.optJSONArray("tool_calls")
            if (tcArr != null) {
                for (i in 0 until tcArr.length()) {
                    val tc = tcArr.getJSONObject(i)
                    val fn = tc.optJSONObject("function")
                    if (fn != null) {
                        toolCalls.add(
                            ToolCall(
                                id = tc.optString("id", "call_$i"),
                                name = fn.optString("name"),
                                argumentsJson = fn.optString("arguments", "{}")
                            )
                        )
                    }
                }
            }

            val sentences = parseEmotionalSentences(content)
            return BrainResponse(
                sentences = sentences,
                toolCalls = toolCalls,
                rawText = content,
                modelUsed = model.id,
                providerUsed = provider.nickname
            )
        }
    }

    // --- 2. Anthropic Adapter ---
    private fun executeAnthropic(
        provider: LLMProvider,
        model: AriaModel,
        userMessage: String,
        screenContext: String?,
        screenshotBase64: String?,
        history: List<Pair<String, String>>,
        enableTools: Boolean
    ): BrainResponse? {
        val root = JSONObject()
        root.put("model", model.id)
        root.put("max_tokens", 1024)
        root.put("system", getSystemPrompt())

        val messages = JSONArray()
        val userObj = JSONObject()
        userObj.put("role", "user")

        val promptText = buildString {
            append(userMessage)
            if (!screenContext.isNullOrBlank()) {
                append("\n\n[Foreground Screen UI]:\n")
                append(screenContext.take(1500))
            }
        }

        val contentArr = JSONArray()
        if (model.supportsImages && screenshotBase64 != null) {
            val imgPart = JSONObject()
            imgPart.put("type", "image")
            val source = JSONObject()
            source.put("type", "base64")
            source.put("media_type", "image/jpeg")
            source.put("data", screenshotBase64)
            imgPart.put("source", source)
            contentArr.put(imgPart)
        }

        val textPart = JSONObject()
        textPart.put("type", "text")
        textPart.put("text", promptText)
        contentArr.put(textPart)

        userObj.put("content", contentArr)
        messages.put(userObj)
        root.put("messages", messages)

        if (enableTools) {
            root.put("tools", buildAnthropicTools())
        }

        val url = if (provider.baseUrl.endsWith("/messages")) provider.baseUrl else "${provider.baseUrl.removeSuffix("/")}/messages"

        val request = Request.Builder()
            .url(url)
            .addHeader("x-api-key", provider.apiKey)
            .addHeader("anthropic-version", "2023-06-01")
            .post(root.toString().toRequestBody(jsonMediaType))
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body?.string() ?: return null
            val json = JSONObject(body)
            val contentList = json.optJSONArray("content") ?: return null

            var fullText = ""
            val toolCalls = mutableListOf<ToolCall>()

            for (i in 0 until contentList.length()) {
                val block = contentList.getJSONObject(i)
                when (block.optString("type")) {
                    "text" -> fullText += block.optString("text")
                    "tool_use" -> {
                        toolCalls.add(
                            ToolCall(
                                id = block.optString("id", "call_$i"),
                                name = block.optString("name"),
                                argumentsJson = block.optJSONObject("input")?.toString() ?: "{}"
                            )
                        )
                    }
                }
            }

            val sentences = parseEmotionalSentences(fullText)
            return BrainResponse(
                sentences = sentences,
                toolCalls = toolCalls,
                rawText = fullText,
                modelUsed = model.id,
                providerUsed = provider.nickname
            )
        }
    }

    // --- 3. Gemini Adapter ---
    private fun executeGemini(
        provider: LLMProvider,
        model: AriaModel,
        userMessage: String,
        screenContext: String?,
        screenshotBase64: String?,
        history: List<Pair<String, String>>,
        enableTools: Boolean
    ): BrainResponse? {
        val root = JSONObject()

        val sysObj = JSONObject()
        val sysParts = JSONArray()
        sysParts.put(JSONObject().put("text", getSystemPrompt()))
        sysObj.put("parts", sysParts)
        root.put("systemInstruction", sysObj)

        val contents = JSONArray()
        val userContent = JSONObject()
        userContent.put("role", "user")
        val parts = JSONArray()

        val promptText = buildString {
            append(userMessage)
            if (!screenContext.isNullOrBlank()) {
                append("\n\n[Foreground Screen UI]:\n")
                append(screenContext.take(1500))
            }
        }
        parts.put(JSONObject().put("text", promptText))

        if (model.supportsImages && screenshotBase64 != null) {
            val imgPart = JSONObject()
            val inlineData = JSONObject()
            inlineData.put("mimeType", "image/jpeg")
            inlineData.put("data", screenshotBase64)
            imgPart.put("inlineData", inlineData)
            parts.put(imgPart)
        }
        userContent.put("parts", parts)
        contents.put(userContent)
        root.put("contents", contents)

        if (enableTools) {
            root.put("tools", buildGeminiTools())
        }

        val cleanModel = model.id.removePrefix("models/")
        val baseUrl = provider.baseUrl.removeSuffix("/")
        val url = "$baseUrl/models/$cleanModel:generateContent?key=${provider.apiKey}"

        val request = Request.Builder()
            .url(url)
            .post(root.toString().toRequestBody(jsonMediaType))
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body?.string() ?: return null
            val json = JSONObject(body)
            val candidates = json.optJSONArray("candidates") ?: return null
            if (candidates.length() == 0) return null

            val candidate = candidates.getJSONObject(0)
            val contentObj = candidate.optJSONObject("content") ?: return null
            val partsArr = contentObj.optJSONArray("parts") ?: return null

            var fullText = ""
            val toolCalls = mutableListOf<ToolCall>()

            for (i in 0 until partsArr.length()) {
                val p = partsArr.getJSONObject(i)
                if (p.has("text")) {
                    fullText += p.getString("text")
                }
                if (p.has("functionCall")) {
                    val fn = p.getJSONObject("functionCall")
                    toolCalls.add(
                        ToolCall(
                            id = "call_$i",
                            name = fn.optString("name"),
                            argumentsJson = fn.optJSONObject("args")?.toString() ?: "{}"
                        )
                    )
                }
            }

            val sentences = parseEmotionalSentences(fullText)
            return BrainResponse(
                sentences = sentences,
                toolCalls = toolCalls,
                rawText = fullText,
                modelUsed = model.id,
                providerUsed = provider.nickname
            )
        }
    }

    // --- JSON Parser for Emotional Sentences ---
    fun parseEmotionalSentences(rawContent: String): List<EmotionalSentence> {
        val trimmed = rawContent.trim()
        if (trimmed.isEmpty()) return emptyList()

        // Attempt structured JSON parse
        try {
            val jsonString = if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                trimmed
            } else {
                val start = trimmed.indexOf('{')
                val end = trimmed.lastIndexOf('}')
                if (start in 0 until end) trimmed.substring(start, end + 1) else null
            }

            if (jsonString != null) {
                val obj = JSONObject(jsonString)
                val sentencesArr = obj.optJSONArray("sentences")
                if (sentencesArr != null && sentencesArr.length() > 0) {
                    val list = mutableListOf<EmotionalSentence>()
                    for (i in 0 until sentencesArr.length()) {
                        val sObj = sentencesArr.getJSONObject(i)
                        val text = sObj.optString("text", "").trim()
                        if (text.isNotEmpty()) {
                            val emotion = AriaEmotion.fromString(sObj.optString("emotion", "neutral"))
                            val intensity = sObj.optInt("intensity", 1).coerceIn(1, 3)
                            val effect = sObj.optString("effect", "none")
                            val stylePrompt = sObj.optString("style_prompt", "")
                            list.add(
                                EmotionalSentence(
                                    text = text,
                                    emotion = emotion,
                                    intensity = intensity,
                                    effect = effect,
                                    stylePrompt = stylePrompt
                                )
                            )
                        }
                    }
                    if (list.isNotEmpty()) return list
                }
            }
        } catch (e: Exception) {
            Log.d(tag, "Direct JSON parse fallback: ${e.message}")
        }

        // Fallback: Split raw plain text into natural sentences and infer childlike emotions
        val split = trimmed.split(Regex("(?<=[.!?])\\s+")).filter { it.isNotBlank() }
        return split.map { s ->
            val emotion = inferEmotionFromText(s)
            EmotionalSentence(
                text = s,
                emotion = emotion,
                intensity = if (s.contains("!") || s.contains("yay", true)) 2 else 1,
                effect = "none"
            )
        }
    }

    private fun inferEmotionFromText(text: String): AriaEmotion {
        val l = text.lowercase()
        return when {
            l.contains("yay") || l.contains("hooray") || l.contains("awesome") || l.contains("super") -> AriaEmotion.EXCITED
            l.contains("thank") || l.contains("sweet") || l.contains("blush") || l.contains("hehe") -> AriaEmotion.SHY
            l.contains("wow") || l.contains("really") || l.contains("whoa") -> AriaEmotion.SURPRISED
            l.contains("what") || l.contains("why") || l.contains("how") || l.contains("look") -> AriaEmotion.CURIOUS
            l.contains("yawn") || l.contains("sleepy") || l.contains("tired") || l.contains("night") -> AriaEmotion.SLEEPY
            l.contains("happy") || l.contains("smile") || l.contains("great") || l.contains("love") -> AriaEmotion.HAPPY
            l.contains("sorry") || l.contains("sad") || l.contains("aww") -> AriaEmotion.SAD
            l.contains("no!") || l.contains("stop") || l.contains("hey!") -> AriaEmotion.ANNOYED
            l.contains("i did it") || l.contains("tada") || l.contains("ta-da") -> AriaEmotion.PROUD
            else -> AriaEmotion.HAPPY
        }
    }

    private fun defaultFallbackResponse(message: String): BrainResponse {
        return BrainResponse(
            sentences = listOf(
                EmotionalSentence(
                    text = message,
                    emotion = AriaEmotion.SHY,
                    intensity = 1,
                    effect = "sigh"
                )
            ),
            toolCalls = emptyList(),
            rawText = message,
            modelUsed = null,
            providerUsed = null
        )
    }

    // --- Tools Schemas for each Provider format ---
    private fun buildOpenAITools(): JSONArray {
        val tools = JSONArray()
        tools.put(createOpenAITool("tap", "Tap on an element by text/id or screen coordinates (x,y)",
            mapOf("element" to "string", "x" to "number", "y" to "number")))
        tools.put(createOpenAITool("swipe", "Swipe or scroll the screen in a direction",
            mapOf("direction" to "string ('up', 'down', 'left', 'right')")))
        tools.put(createOpenAITool("type_text", "Type text into the currently focused text field",
            mapOf("text" to "string")))
        tools.put(createOpenAITool("press_back", "Press the Android system Back button", emptyMap()))
        tools.put(createOpenAITool("press_home", "Press the Android system Home button", emptyMap()))
        tools.put(createOpenAITool("open_app", "Launch an application by name (e.g. 'YouTube', 'Settings')",
            mapOf("name" to "string")))
        tools.put(createOpenAITool("direct_intent", "Execute a fast system intent: call, sms, whatsapp, alarm, timer, calendar, navigation, music, flashlight, wifi_panel, settings",
            mapOf("action" to "string", "target" to "string", "content" to "string")))
        tools.put(createOpenAITool("finish", "Finish the automation task and announce summary",
            mapOf("summary" to "string")))
        return tools
    }

    private fun createOpenAITool(name: String, description: String, properties: Map<String, String>): JSONObject {
        val tool = JSONObject()
        tool.put("type", "function")
        val fn = JSONObject()
        fn.put("name", name)
        fn.put("description", description)
        val params = JSONObject()
        params.put("type", "object")
        val propsObj = JSONObject()
        for ((k, v) in properties) {
            propsObj.put(k, JSONObject().put("type", if (v.startsWith("number")) "number" else "string").put("description", v))
        }
        params.put("properties", propsObj)
        fn.put("parameters", params)
        tool.put("function", fn)
        return tool
    }

    private fun buildAnthropicTools(): JSONArray {
        val tools = JSONArray()
        val openAITools = buildOpenAITools()
        for (i in 0 until openAITools.length()) {
            val fn = openAITools.getJSONObject(i).getJSONObject("function")
            val tool = JSONObject()
            tool.put("name", fn.getString("name"))
            tool.put("description", fn.getString("description"))
            tool.put("input_schema", fn.getJSONObject("parameters"))
            tools.put(tool)
        }
        return tools
    }

    private fun buildGeminiTools(): JSONArray {
        val tools = JSONArray()
        val container = JSONObject()
        val fnDecls = JSONArray()
        val openAITools = buildOpenAITools()
        for (i in 0 until openAITools.length()) {
            val fn = openAITools.getJSONObject(i).getJSONObject("function")
            fnDecls.put(fn)
        }
        container.put("functionDeclarations", fnDecls)
        tools.put(container)
        return tools
    }
}
