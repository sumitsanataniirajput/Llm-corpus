package com.example

import com.example.model.AriaEmotion
import com.example.model.AriaModel
import com.example.model.AvatarState
import com.example.model.EmotionalSentence
import com.example.model.ProviderType
import com.example.model.TTSProviderType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExampleUnitTest {

    @Test
    fun addition_isCorrect() {
        assertEquals(4, 2 + 2)
    }

    @Test
    fun ariaModel_displayName_fallback() {
        val modelWithNick = AriaModel(id = "anthropic/claude-3.5-sonnet", nickname = "Claude Sonnet")
        assertEquals("Claude Sonnet", modelWithNick.displayName)

        val modelNoNick = AriaModel(id = "meta-llama/llama-3.3-70b-instruct", nickname = "")
        assertEquals("meta-llama/llama-3.3-70b-instruct", modelNoNick.displayName)
    }

    @Test
    fun ariaEmotion_fromString_matching() {
        assertEquals(AriaEmotion.HAPPY, AriaEmotion.fromString("happy"))
        assertEquals(AriaEmotion.EXCITED, AriaEmotion.fromString("EXCITED"))
        assertEquals(AriaEmotion.SHY, AriaEmotion.fromString("Shy"))
        assertEquals(AriaEmotion.SURPRISED, AriaEmotion.fromString("surprised"))
        assertEquals(AriaEmotion.CURIOUS, AriaEmotion.fromString("curious"))
        assertEquals(AriaEmotion.NEUTRAL, AriaEmotion.fromString("unknown_emotion"))
    }

    @Test
    fun providerType_defaults() {
        assertEquals("https://openrouter.ai/api/v1", ProviderType.OPENAI_COMPATIBLE.defaultBaseUrl)
        assertEquals("https://api.anthropic.com/v1", ProviderType.ANTHROPIC.defaultBaseUrl)
        assertEquals("https://generativelanguage.googleapis.com/v1beta", ProviderType.GEMINI.defaultBaseUrl)
    }

    @Test
    fun emotionalSentence_properties() {
        val sentence = EmotionalSentence(
            text = "Hehe! That was so much fun!",
            emotion = AriaEmotion.EXCITED,
            intensity = 3,
            effect = "laugh"
        )
        assertEquals("Hehe! That was so much fun!", sentence.text)
        assertEquals(AriaEmotion.EXCITED, sentence.emotion)
        assertEquals(3, sentence.intensity)
        assertEquals("laugh", sentence.effect)
    }

    @Test
    fun avatarState_enum_values() {
        val states = AvatarState.values()
        assertTrue(states.contains(AvatarState.SLEEPING))
        assertTrue(states.contains(AvatarState.LISTENING))
        assertTrue(states.contains(AvatarState.THINKING))
        assertTrue(states.contains(AvatarState.SPEAKING))
        assertTrue(states.contains(AvatarState.WORKING))
    }
}
