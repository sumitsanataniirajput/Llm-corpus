package com.example.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.FlashlightOn
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Nightlight
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.example.data.AriaPreferences
import com.example.model.AriaEmotion
import com.example.model.AvatarState
import com.example.service.AriaAccessibilityService
import com.example.service.AriaOverlayService
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaBorderStrong
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceCard
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaHeroGradient
import com.example.ui.theme.AriaHotPink
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaNeonViolet
import com.example.ui.theme.AriaPinkRedGradient
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaSubtleText
import com.example.ui.theme.AriaSuccess
import com.example.ui.theme.AriaText

@Composable
fun HomeScreen(
    prefs: AriaPreferences,
    onNavigateToChat: () -> Unit,
    onNavigateToSettings: () -> Unit,
    onNavigateToPermissions: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val overlayRunning = AriaOverlayService.isRunning
    val accessibilityRunning = AriaAccessibilityService.isRunning
    val overlayService = AriaOverlayService.instance

    val avatarState = overlayService?.speechEngine?.avatarState?.collectAsState()?.value ?: AvatarState.SLEEPING
    val currentEmotion = overlayService?.speechEngine?.currentEmotion?.collectAsState()?.value ?: AriaEmotion.HAPPY
    val audioAmplitude = overlayService?.speechEngine?.audioAmplitude?.collectAsState()?.value ?: 0f
    val isReadingScreen by AriaAccessibilityService.isReadingScreen.collectAsState()
    val isAwarenessActive by AriaAccessibilityService.isAwarenessActive.collectAsState()
    val speechBubbleText = overlayService?.speechBubbleText?.collectAsState()?.value

    var quickInputText by remember { mutableStateOf("") }

    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            AriaOverlayService.instance?.onMicrophonePermissionGranted()
        }
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // --- 1. Top Bar with Pill Tag (Styled exactly like reference top navigation) ---
        item {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                // Glow Dot + Brand Pill
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(AriaDarkSurface)
                        .border(1.dp, AriaBorder, RoundedCornerShape(20.dp))
                        .padding(horizontal = 12.dp, vertical = 6.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(if (overlayRunning) AriaSuccess else AriaPrimary)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Aria AI",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = AriaText
                    )
                }

                Spacer(modifier = Modifier.weight(1f))

                // Launch Overlay Pill Button in Header
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(
                            if (overlayRunning) AriaSecondary.copy(alpha = 0.3f) else AriaPrimary.copy(alpha = 0.2f)
                        )
                        .border(
                            1.dp,
                            if (overlayRunning) AriaSecondary else AriaPrimary,
                            RoundedCornerShape(20.dp)
                        )
                        .clickable {
                            if (overlayRunning) {
                                AriaOverlayService.stop(context)
                            } else {
                                val hasOverlay = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(context) else true
                                val hasMic = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

                                if (!hasOverlay) {
                                    onNavigateToPermissions()
                                } else {
                                    if (!hasMic) micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                    AriaOverlayService.start(context)
                                }
                            }
                        }
                        .padding(horizontal = 14.dp, vertical = 6.dp)
                ) {
                    Text(
                        text = if (overlayRunning) "Overlay Active" else "Launch Overlay",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (overlayRunning) AriaAccent else AriaText
                    )
                }

                Spacer(modifier = Modifier.width(8.dp))

                IconButton(
                    onClick = onNavigateToSettings,
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(AriaDarkSurface)
                        .border(1.dp, AriaBorder, CircleShape)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Settings,
                        contentDescription = "Settings",
                        tint = AriaText,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }

        // --- 2. Hero Headline Section (Matching reference typography & cosmic ambient glow) ---
        item {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                contentAlignment = Alignment.Center
            ) {
                // Subtle cosmic glow behind headline
                Box(
                    modifier = Modifier
                        .size(240.dp, 80.dp)
                        .background(
                            brush = Brush.radialGradient(
                                colors = listOf(Color(0x339D4EDD), Color(0x117209B7), Color.Transparent)
                            ),
                            shape = CircleShape
                        )
                )

                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    // Small Category Pill
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color(0x22B5179E))
                            .border(1.dp, Color(0x55B5179E), RoundedCornerShape(12.dp))
                            .padding(horizontal = 10.dp, vertical = 3.dp)
                    ) {
                        Text(
                            text = "Next-Gen AI Companion",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = AriaHotPink
                        )
                    }

                    Spacer(modifier = Modifier.height(10.dp))

                    Text(
                        text = "Smartest & Easiest Way\nto Control Your Phone",
                        fontSize = 24.sp,
                        lineHeight = 30.sp,
                        fontWeight = FontWeight.ExtraBold,
                        textAlign = TextAlign.Center,
                        color = AriaText
                    )

                    Spacer(modifier = Modifier.height(8.dp))

                    Text(
                        text = "Floating avatar, hands-free screen reading, and custom automations.",
                        fontSize = 13.sp,
                        lineHeight = 18.sp,
                        textAlign = TextAlign.Center,
                        color = AriaMutedText,
                        modifier = Modifier.padding(horizontal = 12.dp)
                    )
                }
            }
        }

        // --- 3. Large Cosmic Avatar Card with Glowing Radial Halo ---
        item {
            Card(
                shape = RoundedCornerShape(24.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = BorderStroke(1.dp, AriaBorderStrong),
                elevation = CardDefaults.cardElevation(defaultElevation = 10.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    // Avatar with cosmic halo
                    Box(
                        modifier = Modifier
                            .size(150.dp)
                            .background(
                                brush = Brush.radialGradient(
                                    colors = listOf(
                                        Color(0x66B5179E),
                                        Color(0x337209B7),
                                        Color.Transparent
                                    )
                                ),
                                shape = CircleShape
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        AriaAvatarComponent(
                            state = avatarState,
                            emotion = currentEmotion,
                            audioAmplitude = audioAmplitude,
                            isReadingScreen = isReadingScreen,
                            isAwarenessActive = isAwarenessActive,
                            size = 120.dp,
                            customAvatarUri = prefs.customAvatarUri
                        )
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    Text(
                        text = prefs.assistantName,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                        color = AriaText
                    )

                    Spacer(modifier = Modifier.height(8.dp))

                    // Status chip row (Matching reference glowing tags)
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        // Avatar state chip (Sleeping, Listening, Thinking, Speaking, Working)
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(
                                    when (avatarState) {
                                        AvatarState.SLEEPING -> Color(0xFF1F122B)
                                        AvatarState.LISTENING -> Color(0x339D4EDD)
                                        AvatarState.THINKING -> Color(0x33FFA000)
                                        AvatarState.SPEAKING -> Color(0x33B5179E)
                                        AvatarState.WORKING -> Color(0x334ADE80)
                                    }
                                )
                                .border(
                                    1.dp,
                                    when (avatarState) {
                                        AvatarState.SLEEPING -> AriaMutedText.copy(alpha = 0.4f)
                                        AvatarState.LISTENING -> AriaNeonViolet
                                        AvatarState.THINKING -> Color(0xFFFFA000)
                                        AvatarState.SPEAKING -> AriaPrimary
                                        AvatarState.WORKING -> AriaSuccess
                                    },
                                    RoundedCornerShape(12.dp)
                                )
                                .padding(horizontal = 10.dp, vertical = 4.dp)
                        ) {
                            Text(
                                text = if (avatarState == AvatarState.SLEEPING) "Sleeping (Eyes Closed)" else avatarState.name,
                                fontWeight = FontWeight.Bold,
                                fontSize = 11.sp,
                                color = when (avatarState) {
                                    AvatarState.SLEEPING -> AriaMutedText
                                    AvatarState.LISTENING -> AriaAccent
                                    AvatarState.THINKING -> Color(0xFFFFA000)
                                    AvatarState.SPEAKING -> AriaHotPink
                                    AvatarState.WORKING -> AriaSuccess
                                }
                            )
                        }

                        // Mood Emotion Chip
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(Color(currentEmotion.colorHex).copy(alpha = 0.2f))
                                .border(1.dp, Color(currentEmotion.colorHex).copy(alpha = 0.6f), RoundedCornerShape(12.dp))
                                .padding(horizontal = 10.dp, vertical = 4.dp)
                        ) {
                            Text(
                                text = "Mood: ${currentEmotion.name.lowercase()}",
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 11.sp,
                                color = Color(currentEmotion.colorHex)
                            )
                        }

                        // Screen Awareness Chip
                        if (isAwarenessActive) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(AriaAccent.copy(alpha = 0.15f))
                                    .border(1.dp, AriaAccent.copy(alpha = 0.5f), RoundedCornerShape(12.dp))
                                    .padding(horizontal = 8.dp, vertical = 4.dp)
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Box(
                                        modifier = Modifier
                                            .size(6.dp)
                                            .clip(CircleShape)
                                            .background(if (isReadingScreen) AriaHotPink else AriaAccent)
                                    )
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text(
                                        text = if (isReadingScreen) "Reading" else "Aware",
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        color = AriaAccent
                                    )
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    // Wake-Phrase Pill
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(16.dp))
                            .background(AriaDarkSurfaceElevated)
                            .border(1.dp, AriaBorder, RoundedCornerShape(16.dp))
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Outlined.Mic,
                                contentDescription = null,
                                tint = AriaHotPink,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = "Say \"${prefs.wakePhrase}\"",
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 13.sp,
                                color = AriaText
                            )
                        }
                    }
                }
            }
        }

        // --- 4. Interactive Command Input Box (Like the reference "Turn your text into video" prompt card) ---
        item {
            Card(
                shape = RoundedCornerShape(22.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurfaceCard),
                border = BorderStroke(1.dp, AriaBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "Send Command or Question",
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp,
                            color = AriaText
                        )
                        Spacer(modifier = Modifier.weight(1f))
                        Text(
                            text = "Text & Voice",
                            fontSize = 11.sp,
                            color = AriaAccent
                        )
                    }

                    Spacer(modifier = Modifier.height(10.dp))

                    // Text Input Bar with glowing border and send button
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(AriaDarkSurfaceElevated)
                            .border(1.dp, AriaBorderStrong, RoundedCornerShape(14.dp))
                            .padding(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        BasicTextField(
                            value = quickInputText,
                            onValueChange = { quickInputText = it },
                            textStyle = TextStyle(color = AriaText, fontSize = 14.sp),
                            cursorBrush = SolidColor(AriaHotPink),
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                            keyboardActions = KeyboardActions(
                                onSend = {
                                    if (quickInputText.isNotBlank()) {
                                        val cmd = quickInputText
                                        quickInputText = ""
                                        prefs.addChatMessage("USER", cmd)
                                        AriaOverlayService.instance?.agentLoop?.executeUserCommand(cmd)
                                    }
                                }
                            ),
                            modifier = Modifier.weight(1f),
                            decorationBox = { innerTextField ->
                                if (quickInputText.isEmpty()) {
                                    Text(
                                        text = "Type any command (e.g. read screen, open app)...",
                                        style = TextStyle(color = AriaMutedText, fontSize = 13.sp)
                                    )
                                }
                                innerTextField()
                            }
                        )

                        IconButton(
                            onClick = {
                                if (quickInputText.isNotBlank()) {
                                    val cmd = quickInputText
                                    quickInputText = ""
                                    prefs.addChatMessage("USER", cmd)
                                    AriaOverlayService.instance?.agentLoop?.executeUserCommand(cmd)
                                } else {
                                    AriaOverlayService.instance?.speechEngine?.wakeUp()
                                }
                            },
                            modifier = Modifier.size(34.dp)
                        ) {
                            if (quickInputText.isNotBlank()) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Outlined.Send,
                                    contentDescription = "Send",
                                    tint = AriaHotPink,
                                    modifier = Modifier.size(18.dp)
                                )
                            } else {
                                Icon(
                                    imageVector = Icons.Outlined.Mic,
                                    contentDescription = "Voice",
                                    tint = AriaNeonViolet,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                        }
                    }
                }
            }
        }

        // --- 5. Latest Reply in a Clean Speech Bubble ---
        if (!speechBubbleText.isNullOrBlank()) {
            item {
                Card(
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(containerColor = AriaDarkSurfaceElevated),
                    border = BorderStroke(1.dp, AriaBorderStrong),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "Aria's Latest Reply",
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                color = AriaHotPink
                            )
                            Spacer(modifier = Modifier.weight(1f))
                            Text(
                                text = "Just now",
                                fontSize = 11.sp,
                                color = AriaMutedText
                            )
                        }
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = speechBubbleText ?: "",
                            fontSize = 14.sp,
                            color = AriaText,
                            lineHeight = 20.sp
                        )
                    }
                }
            }
        }

        // --- 6. Quick Action Cards (Styled like the reference 3-column feature cards) ---
        item {
            Card(
                shape = RoundedCornerShape(22.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = BorderStroke(1.dp, AriaBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(18.dp)) {
                    Text(
                        text = "Quick Controls",
                        fontWeight = FontWeight.Bold,
                        color = AriaText,
                        fontSize = 15.sp
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        // Wake Button
                        OutlinedButton(
                            onClick = {
                                if (AriaOverlayService.isRunning) {
                                    AriaOverlayService.instance?.speechEngine?.wakeUp()
                                } else {
                                    AriaOverlayService.start(context)
                                }
                            },
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, AriaBorder),
                            modifier = Modifier
                                .weight(1f)
                                .height(46.dp)
                        ) {
                            Icon(Icons.Outlined.Mic, contentDescription = null, tint = AriaHotPink, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Wake", fontSize = 12.sp, color = AriaText)
                        }

                        // Sleep Button
                        OutlinedButton(
                            onClick = {
                                AriaOverlayService.instance?.speechEngine?.goToSleep()
                            },
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, AriaBorder),
                            modifier = Modifier
                                .weight(1f)
                                .height(46.dp)
                        ) {
                            Icon(Icons.Outlined.Nightlight, contentDescription = null, tint = AriaMutedText, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Sleep", fontSize = 12.sp, color = AriaText)
                        }

                        // Read Screen Button
                        OutlinedButton(
                            onClick = {
                                if (AriaOverlayService.isRunning) {
                                    AriaOverlayService.instance?.agentLoop?.executeUserCommand("what's on my screen?")
                                } else {
                                    AriaOverlayService.start(context)
                                }
                            },
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, AriaBorder),
                            modifier = Modifier
                                .weight(1f)
                                .height(46.dp)
                        ) {
                            Icon(Icons.Outlined.Visibility, contentDescription = null, tint = AriaAccent, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Read", fontSize = 12.sp, color = AriaText)
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        // Chat action
                        OutlinedButton(
                            onClick = onNavigateToChat,
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, AriaBorder),
                            modifier = Modifier
                                .weight(1f)
                                .height(46.dp)
                        ) {
                            Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, tint = AriaPrimary, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Open Chat", fontSize = 12.sp, color = AriaText)
                        }

                        // Flashlight task test
                        OutlinedButton(
                            onClick = {
                                AriaOverlayService.instance?.agentLoop?.executeUserCommand("turn on flashlight")
                            },
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, AriaBorder),
                            modifier = Modifier
                                .weight(1f)
                                .height(46.dp)
                        ) {
                            Icon(Icons.Outlined.FlashlightOn, contentDescription = null, tint = Color(0xFFFFB300), modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Flashlight", fontSize = 12.sp, color = AriaText)
                        }
                    }
                }
            }
        }
    }
}
