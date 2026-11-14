package com.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.VolumeUp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.model.AriaEmotion
import com.example.model.EmotionalSentence
import com.example.model.TTSProviderType
import com.example.service.AriaOverlayService
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPinkRedGradient
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaSuccess
import com.example.ui.theme.AriaText

@Composable
fun VoiceSettingsScreen(
    prefs: AriaPreferences,
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    val ttsConfig by prefs.ttsConfigState.collectAsState()

    var activeTTSProvider by remember(ttsConfig) { mutableStateOf(ttsConfig.activeProvider) }
    var elevenLabsKey by remember(ttsConfig) { mutableStateOf(ttsConfig.elevenLabsApiKey) }
    var elevenLabsVoiceId by remember(ttsConfig) { mutableStateOf(ttsConfig.elevenLabsVoiceId) }
    var openAIKey by remember(ttsConfig) { mutableStateOf(ttsConfig.openAIApiKey) }
    var openAIVoice by remember(ttsConfig) { mutableStateOf(ttsConfig.openAIVoice) }
    var geminiKey by remember(ttsConfig) { mutableStateOf(ttsConfig.geminiApiKey) }
    var geminiVoiceName by remember(ttsConfig) { mutableStateOf(ttsConfig.geminiVoiceName) }
    var voiceStyleDesc by remember(ttsConfig) { mutableStateOf(ttsConfig.voiceStyleDescription) }
    var pitch by remember(ttsConfig) { mutableFloatStateOf(ttsConfig.pitch) }
    var speed by remember(ttsConfig) { mutableFloatStateOf(ttsConfig.speed) }

    var isKeyVisible by remember { mutableStateOf(false) }
    val overlayService = AriaOverlayService.instance

    fun saveTTSConfig() {
        prefs.updateTTSConfig(
            ttsConfig.copy(
                activeProvider = activeTTSProvider,
                elevenLabsApiKey = elevenLabsKey.trim(),
                elevenLabsVoiceId = elevenLabsVoiceId.trim(),
                openAIApiKey = openAIKey.trim(),
                openAIVoice = openAIVoice.trim(),
                geminiApiKey = geminiKey.trim(),
                geminiVoiceName = geminiVoiceName.trim(),
                voiceStyleDescription = voiceStyleDesc.trim(),
                pitch = pitch,
                speed = speed
            )
        )
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Top Header
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (onBack != null) {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                            contentDescription = "Back",
                            tint = AriaText
                        )
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                }
                Column {
                    Text(
                        text = "Voice and Emotions",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = AriaText
                    )
                    Text(
                        text = "Pluggable emotional voice synthesis with childlike conditioning",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )
                }
            }
        }

        // TTS Engine Selection Card
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Outlined.RecordVoiceOver,
                            contentDescription = null,
                            tint = AriaPrimary,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Speech Synthesis Provider",
                            fontWeight = FontWeight.Bold,
                            color = AriaText,
                            fontSize = 15.sp
                        )
                    }

                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = "Switch between offline on-device voice and lifelike emotional neural voices.",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )

                    Spacer(modifier = Modifier.height(14.dp))

                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        TTSProviderType.values().forEach { provider ->
                            val isSelected = activeTTSProvider == provider
                            FilterChip(
                                selected = isSelected,
                                onClick = {
                                    activeTTSProvider = provider
                                    saveTTSConfig()
                                },
                                label = { Text(provider.displayName, fontSize = 12.sp) },
                                leadingIcon = if (isSelected) {
                                    { Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
                                } else null,
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = AriaDarkSurfaceElevated,
                                    selectedLabelColor = AriaPrimary,
                                    containerColor = AriaDarkSurface,
                                    labelColor = AriaMutedText
                                ),
                                border = FilterChipDefaults.filterChipBorder(
                                    enabled = true,
                                    selected = isSelected,
                                    borderColor = if (isSelected) AriaPrimary else AriaBorder
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    when (activeTTSProvider) {
                        TTSProviderType.ELEVENLABS -> {
                            OutlinedTextField(
                                value = elevenLabsKey,
                                onValueChange = {
                                    elevenLabsKey = it
                                    saveTTSConfig()
                                },
                                label = { Text("ElevenLabs API Key") },
                                singleLine = true,
                                visualTransformation = if (isKeyVisible) VisualTransformation.None else PasswordVisualTransformation(),
                                trailingIcon = {
                                    IconButton(onClick = { isKeyVisible = !isKeyVisible }) {
                                        Icon(
                                            imageVector = if (isKeyVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                            contentDescription = null,
                                            tint = AriaMutedText
                                        )
                                    }
                                },
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = AriaPrimary,
                                    unfocusedBorderColor = AriaBorder,
                                    focusedTextColor = AriaText,
                                    unfocusedTextColor = AriaText,
                                    focusedLabelColor = AriaPrimary
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )
                            Spacer(modifier = Modifier.height(10.dp))
                            OutlinedTextField(
                                value = elevenLabsVoiceId,
                                onValueChange = {
                                    elevenLabsVoiceId = it
                                    saveTTSConfig()
                                },
                                label = { Text("Voice ID") },
                                placeholder = { Text("21m00Tcm4TlvDq8ikWAM") },
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = AriaPrimary,
                                    unfocusedBorderColor = AriaBorder,
                                    focusedTextColor = AriaText,
                                    unfocusedTextColor = AriaText,
                                    focusedLabelColor = AriaPrimary
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        TTSProviderType.OPENAI_TTS -> {
                            OutlinedTextField(
                                value = openAIKey,
                                onValueChange = {
                                    openAIKey = it
                                    saveTTSConfig()
                                },
                                label = { Text("OpenAI API Key") },
                                singleLine = true,
                                visualTransformation = if (isKeyVisible) VisualTransformation.None else PasswordVisualTransformation(),
                                trailingIcon = {
                                    IconButton(onClick = { isKeyVisible = !isKeyVisible }) {
                                        Icon(
                                            imageVector = if (isKeyVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                            contentDescription = null,
                                            tint = AriaMutedText
                                        )
                                    }
                                },
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = AriaPrimary,
                                    unfocusedBorderColor = AriaBorder,
                                    focusedTextColor = AriaText,
                                    unfocusedTextColor = AriaText,
                                    focusedLabelColor = AriaPrimary
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )
                            Spacer(modifier = Modifier.height(10.dp))
                            OutlinedTextField(
                                value = openAIVoice,
                                onValueChange = {
                                    openAIVoice = it
                                    saveTTSConfig()
                                },
                                label = { Text("Voice Name (nova, shimmer, alloy)") },
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = AriaPrimary,
                                    unfocusedBorderColor = AriaBorder,
                                    focusedTextColor = AriaText,
                                    unfocusedTextColor = AriaText,
                                    focusedLabelColor = AriaPrimary
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        TTSProviderType.GEMINI_TTS -> {
                            OutlinedTextField(
                                value = geminiKey,
                                onValueChange = {
                                    geminiKey = it
                                    saveTTSConfig()
                                },
                                label = { Text("Gemini API Key") },
                                singleLine = true,
                                visualTransformation = if (isKeyVisible) VisualTransformation.None else PasswordVisualTransformation(),
                                trailingIcon = {
                                    IconButton(onClick = { isKeyVisible = !isKeyVisible }) {
                                        Icon(
                                            imageVector = if (isKeyVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                            contentDescription = null,
                                            tint = AriaMutedText
                                        )
                                    }
                                },
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = AriaPrimary,
                                    unfocusedBorderColor = AriaBorder,
                                    focusedTextColor = AriaText,
                                    unfocusedTextColor = AriaText,
                                    focusedLabelColor = AriaPrimary
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )
                            Spacer(modifier = Modifier.height(10.dp))
                            OutlinedTextField(
                                value = geminiVoiceName,
                                onValueChange = {
                                    geminiVoiceName = it
                                    saveTTSConfig()
                                },
                                label = { Text("Voice Name (Puck, Aoede)") },
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = AriaPrimary,
                                    unfocusedBorderColor = AriaBorder,
                                    focusedTextColor = AriaText,
                                    unfocusedTextColor = AriaText,
                                    focusedLabelColor = AriaPrimary
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        TTSProviderType.ANDROID_TTS -> {
                            Text(
                                text = "Using on-device Android Text-to-Speech engine. 100% offline with dynamic emotion pitch and rate modulation.",
                                fontSize = 12.sp,
                                color = AriaSuccess
                            )
                        }
                    }
                }
            }
        }

        // Voice Style & Emotion Conditioning Card
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Persona & Voice Style Conditioning",
                        fontWeight = FontWeight.Bold,
                        color = AriaText,
                        fontSize = 15.sp
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Conditioning text passed to neural speech synthesizers.",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )
                    Spacer(modifier = Modifier.height(10.dp))

                    OutlinedTextField(
                        value = voiceStyleDesc,
                        onValueChange = {
                            voiceStyleDesc = it
                            saveTTSConfig()
                        },
                        label = { Text("Voice Description Prompt") },
                        singleLine = false,
                        maxLines = 3,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = AriaPrimary,
                            unfocusedBorderColor = AriaBorder,
                            focusedTextColor = AriaText,
                            unfocusedTextColor = AriaText,
                            focusedLabelColor = AriaPrimary
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(14.dp))
                    Text(
                        text = "Voice Pitch: ${"%.2f".format(pitch)}x (Childlike / Bright)",
                        fontSize = 13.sp,
                        color = AriaText,
                        fontWeight = FontWeight.SemiBold
                    )
                    Slider(
                        value = pitch,
                        onValueChange = {
                            pitch = it
                            saveTTSConfig()
                        },
                        valueRange = 0.8f..1.5f,
                        colors = SliderDefaults.colors(
                            thumbColor = AriaPrimary,
                            activeTrackColor = AriaPrimary
                        )
                    )

                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Speech Rate: ${"%.2f".format(speed)}x",
                        fontSize = 13.sp,
                        color = AriaText,
                        fontWeight = FontWeight.SemiBold
                    )
                    Slider(
                        value = speed,
                        onValueChange = {
                            speed = it
                            saveTTSConfig()
                        },
                        valueRange = 0.8f..1.4f,
                        colors = SliderDefaults.colors(
                            thumbColor = AriaPrimary,
                            activeTrackColor = AriaPrimary
                        )
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Test Voice Button
                    Button(
                        onClick = {
                            overlayService?.speechEngine?.ttsManager?.speakEmotionalSentences(
                                listOf(
                                    EmotionalSentence(
                                        text = "Hehe! Hi there! I'm Aria, and I'm super excited to hang out with you!",
                                        emotion = AriaEmotion.EXCITED,
                                        intensity = 3,
                                        effect = "laugh"
                                    )
                                )
                            )
                        },
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .background(AriaPinkRedGradient, RoundedCornerShape(12.dp))
                    ) {
                        Icon(Icons.Outlined.VolumeUp, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Test Emotional Voice", fontWeight = FontWeight.Bold, color = Color.White)
                    }
                }
            }
        }
    }
}
