package com.example.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.model.AriaEmotion
import com.example.model.AvatarState
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSuccess
import com.example.ui.theme.AriaText

@Composable
fun AriaOverlayContent(
    avatarState: AvatarState,
    speechBubbleText: String?,
    isWorking: Boolean,
    onAvatarSingleTap: () -> Unit,
    onAvatarLongPress: () -> Unit,
    onSendCommand: (String) -> Unit,
    onMicTap: () -> Unit,
    onDismissBubble: () -> Unit,
    emotion: AriaEmotion = AriaEmotion.HAPPY,
    audioAmplitude: Float = 0f,
    isReadingScreen: Boolean = false,
    isAwarenessActive: Boolean = true,
    customAvatarUri: String? = null,
    avatarSize: androidx.compose.ui.unit.Dp = 96.dp,
    modifier: Modifier = Modifier
) {
    var showQuickInput by remember { mutableStateOf(false) }
    var inputText by remember { mutableStateOf("") }

    Column(
        modifier = modifier
            .wrapContentSize()
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // Speech Bubble & Quick Input Panel (Glassmorphism Pink & Plum Card)
        AnimatedVisibility(
            visible = (!speechBubbleText.isNullOrBlank() || showQuickInput),
            enter = fadeIn() + slideInVertically { it / 2 },
            exit = fadeOut() + slideOutVertically { it / 2 }
        ) {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(
                    containerColor = Color(0xF51A1220)
                ),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = SolidColor(AriaPrimary.copy(alpha = 0.50f))
                ),
                elevation = CardDefaults.cardElevation(defaultElevation = 10.dp),
                modifier = Modifier
                    .widthIn(max = 280.dp)
                    .padding(bottom = 8.dp)
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    // Header row with dismiss button
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = if (isWorking) "Aria (Working...)" else "Aria",
                            style = TextStyle(
                                color = if (isWorking) AriaSuccess else AriaPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp
                            )
                        )
                        Spacer(modifier = Modifier.weight(1f))
                        Box(
                            modifier = Modifier
                                .size(22.dp)
                                .clip(CircleShape)
                                .clickable {
                                    showQuickInput = false
                                    onDismissBubble()
                                },
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.Close,
                                contentDescription = "Close Bubble",
                                tint = AriaMutedText,
                                modifier = Modifier.size(15.dp)
                            )
                        }
                    }

                    // Speech bubble message
                    if (!speechBubbleText.isNullOrBlank()) {
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = speechBubbleText,
                            style = TextStyle(
                                color = AriaText,
                                fontSize = 13.sp,
                                lineHeight = 18.sp
                            )
                        )
                    }

                    // Quick Text / Mic Input Bar
                    Spacer(modifier = Modifier.height(10.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(20.dp))
                            .background(AriaDarkSurfaceElevated)
                            .border(1.dp, AriaBorder, RoundedCornerShape(20.dp))
                            .padding(horizontal = 10.dp, vertical = 5.dp)
                    ) {
                        BasicTextField(
                            value = inputText,
                            onValueChange = { inputText = it },
                            textStyle = TextStyle(color = AriaText, fontSize = 13.sp),
                            cursorBrush = SolidColor(AriaPrimary),
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                            keyboardActions = KeyboardActions(
                                onSend = {
                                    if (inputText.isNotBlank()) {
                                        onSendCommand(inputText)
                                        inputText = ""
                                        showQuickInput = false
                                    }
                                }
                            ),
                            modifier = Modifier.weight(1f),
                            decorationBox = { innerTextField ->
                                if (inputText.isEmpty()) {
                                    Text(
                                        text = "Ask Aria or speak...",
                                        style = TextStyle(color = AriaMutedText, fontSize = 12.sp)
                                    )
                                }
                                innerTextField()
                            }
                        )

                        if (inputText.isNotBlank()) {
                            IconButton(
                                onClick = {
                                    onSendCommand(inputText)
                                    inputText = ""
                                    showQuickInput = false
                                },
                                modifier = Modifier.size(28.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Outlined.Send,
                                    contentDescription = "Send",
                                    tint = AriaPrimary,
                                    modifier = Modifier.size(17.dp)
                                )
                            }
                        } else {
                            IconButton(
                                onClick = onMicTap,
                                modifier = Modifier.size(28.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.Mic,
                                    contentDescription = "Speak",
                                    tint = AriaAccent,
                                    modifier = Modifier.size(17.dp)
                                )
                            }
                        }
                    }
                }
            }
        }

        // Draggable Floating Avatar with Emotion Glow Ring
        Box(
            modifier = Modifier
                .wrapContentSize()
                .pointerInput(Unit) {
                    detectTapGestures(
                        onTap = {
                            showQuickInput = !showQuickInput
                            onAvatarSingleTap()
                        },
                        onLongPress = {
                            onAvatarLongPress()
                        }
                    )
                }
        ) {
            AriaAvatarComponent(
                state = avatarState,
                emotion = emotion,
                audioAmplitude = audioAmplitude,
                isReadingScreen = isReadingScreen,
                isAwarenessActive = isAwarenessActive,
                customAvatarUri = customAvatarUri,
                size = avatarSize
            )
        }
    }
}
