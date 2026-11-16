package com.example.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Nightlight
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Visibility
import com.example.model.AriaEmotion
import com.example.model.EmotionalSentence
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.model.AvatarState
import com.example.service.AriaAccessibilityService
import com.example.service.AriaOverlayService

@Composable
fun DashboardScreen(
    prefs: AriaPreferences,
    onNavigateToSetup: () -> Unit,
    onNavigateToModels: () -> Unit,
    onNavigateToHistory: () -> Unit,
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

    val memories by prefs.memoriesState.collectAsState()
    var newMemoryText by remember { mutableStateOf("") }
    var showAddMemory by remember { mutableStateOf(false) }

    val history by prefs.historyState.collectAsState()
    val activeProvider = prefs.getActiveProvider()
    val activeModel = prefs.getActiveModel()

    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            AriaOverlayService.instance?.onMicrophonePermissionGranted()
        }
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Hero Avatar & Status Card
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    AriaAvatarComponent(
                        state = avatarState,
                        emotion = currentEmotion,
                        audioAmplitude = audioAmplitude,
                        isReadingScreen = isReadingScreen,
                        isAwarenessActive = isAwarenessActive,
                        size = 110.dp
                    )

                    Spacer(modifier = Modifier.height(14.dp))
                    Text(
                        text = prefs.assistantName,
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        color = Color.White
                    )

                    Spacer(modifier = Modifier.height(6.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        // State badge
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(6.dp))
                                .background(
                                    when (avatarState) {
                                        AvatarState.SLEEPING -> Color(0xFF8B949E).copy(alpha = 0.2f)
                                        AvatarState.LISTENING -> Color(0xFF00E5FF).copy(alpha = 0.2f)
                                        AvatarState.THINKING -> Color(0xFFFFA000).copy(alpha = 0.2f)
                                        AvatarState.SPEAKING -> Color(0xFFD500F9).copy(alpha = 0.2f)
                                        AvatarState.WORKING -> Color(0xFF00E676).copy(alpha = 0.2f)
                                    }
                                )
                                .padding(horizontal = 8.dp, vertical = 3.dp)
                        ) {
                            Text(
                                text = avatarState.name,
                                fontWeight = FontWeight.Bold,
                                fontSize = 11.sp,
                                color = when (avatarState) {
                                    AvatarState.SLEEPING -> Color(0xFF8B949E)
                                    AvatarState.LISTENING -> Color(0xFF00E5FF)
                                    AvatarState.THINKING -> Color(0xFFFFA000)
                                    AvatarState.SPEAKING -> Color(0xFFD500F9)
                                    AvatarState.WORKING -> Color(0xFF00E676)
                                }
                            )
                        }

                        // Live Emotion badge
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(6.dp))
                                .background(Color(currentEmotion.colorHex).copy(alpha = 0.2f))
                                .padding(horizontal = 8.dp, vertical = 3.dp)
                        ) {
                            Text(
                                text = "Mood: ${currentEmotion.name.lowercase()}",
                                fontWeight = FontWeight.Bold,
                                fontSize = 11.sp,
                                color = Color(currentEmotion.colorHex)
                            )
                        }

                        // Screen Awareness Dot
                        if (isAwarenessActive) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(Color(0xFF00E5FF).copy(alpha = 0.2f))
                                    .padding(horizontal = 6.dp, vertical = 3.dp)
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Box(
                                        modifier = Modifier
                                            .size(6.dp)
                                            .clip(CircleShape)
                                            .background(if (isReadingScreen) Color(0xFF00E5FF) else Color(0xFF00B0FF))
                                    )
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text(
                                        text = if (isReadingScreen) "Reading" else "Aware",
                                        fontSize = 10.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        color = Color(0xFF00E5FF)
                                    )
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    // Active provider & model chip
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center
                    ) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color(0xFF21262D))
                                .padding(horizontal = 10.dp, vertical = 4.dp)
                                .clickable { onNavigateToModels() }
                        ) {
                            Text(
                                text = "Brain: ${activeProvider?.nickname ?: "No Provider"} (${activeModel?.displayName ?: "No Model"})",
                                fontSize = 11.sp,
                                color = if (activeModel != null) Color(0xFF58A6FF) else Color(0xFFF85149)
                            )
                        }

                        Spacer(modifier = Modifier.width(8.dp))
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (accessibilityRunning) Color(0xFF238636).copy(alpha = 0.2f) else Color(0xFFD29922).copy(alpha = 0.2f))
                                .padding(horizontal = 10.dp, vertical = 4.dp)
                                .clickable { onNavigateToSetup() }
                        ) {
                            Text(
                                text = if (accessibilityRunning) "Accessibility Active" else "Enable Accessibility",
                                fontSize = 11.sp,
                                color = if (accessibilityRunning) Color(0xFF3FB950) else Color(0xFFE3B341)
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(16.dp))

                    // Floating Assistant Start / Stop
                    if (overlayRunning) {
                        Button(
                            onClick = { AriaOverlayService.stop(context) },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFDA3633)),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Icon(Icons.Default.Stop, contentDescription = null)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Stop Floating Assistant", fontWeight = FontWeight.Bold)
                        }
                    } else {
                        Button(
                            onClick = {
                                val hasOverlay = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(context) else true
                                val hasMic = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

                                if (!hasOverlay) {
                                    onNavigateToSetup()
                                } else {
                                    if (!hasMic) {
                                        micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                    }
                                    AriaOverlayService.start(context)
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF238636)),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Icon(Icons.Default.Layers, contentDescription = null)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Launch Floating Avatar Over Phone", fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }

        // Quick Testing Action Pad
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Quick Assistant Testing",
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                        fontSize = 15.sp
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Test voice transitions, screen reading, and automation tasks directly.",
                        fontSize = 12.sp,
                        color = Color(0xFF8B949E)
                    )

                    Spacer(modifier = Modifier.height(12.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        OutlinedButton(
                            onClick = {
                                if (AriaOverlayService.isRunning) {
                                    AriaOverlayService.instance?.speechEngine?.wakeUp()
                                } else {
                                    AriaOverlayService.start(context)
                                }
                            },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Default.Mic, contentDescription = null, tint = Color(0xFF00E5FF), modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Wake ('${prefs.wakePhrase}')", fontSize = 11.sp, color = Color.White)
                        }

                        OutlinedButton(
                            onClick = {
                                AriaOverlayService.instance?.speechEngine?.goToSleep()
                            },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Default.Nightlight, contentDescription = null, tint = Color(0xFF7C4DFF), modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Sleep", fontSize = 11.sp, color = Color.White)
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Button(
                            onClick = {
                                if (AriaOverlayService.isRunning) {
                                    AriaOverlayService.instance?.agentLoop?.executeUserCommand("what's on my screen?")
                                } else {
                                    AriaOverlayService.start(context)
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1F6FEB)),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Default.Visibility, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Read My Screen", fontSize = 11.sp)
                        }

                        Button(
                            onClick = {
                                AriaOverlayService.instance?.agentLoop?.executeUserCommand("turn on flashlight")
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF6E40C9)),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Default.FlashlightOn, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Test Flashlight", fontSize = 11.sp)
                        }
                    }

                    Spacer(modifier = Modifier.height(10.dp))
                    Text(
                        text = "Emotion & Voice Expressions:",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.LightGray
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        OutlinedButton(
                            onClick = {
                                AriaOverlayService.instance?.speechEngine?.ttsManager?.speakEmotionalSentences(
                                    listOf(
                                        EmotionalSentence(
                                            text = "Yay! I am so happy right now! Let's do something super fun!",
                                            emotion = AriaEmotion.EXCITED,
                                            intensity = 3,
                                            effect = "laugh"
                                        )
                                    )
                                )
                            },
                            shape = RoundedCornerShape(8.dp),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                            modifier = Modifier.weight(1f).height(32.dp)
                        ) {
                            Text("Excited", fontSize = 10.sp, color = Color(0xFFFF7043))
                        }

                        OutlinedButton(
                            onClick = {
                                AriaOverlayService.instance?.speechEngine?.ttsManager?.speakEmotionalSentences(
                                    listOf(
                                        EmotionalSentence(
                                            text = "Aww... you are so nice to me... thank you so much!",
                                            emotion = AriaEmotion.SHY,
                                            intensity = 2,
                                            effect = "pause_short"
                                        )
                                    )
                                )
                            },
                            shape = RoundedCornerShape(8.dp),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                            modifier = Modifier.weight(1f).height(32.dp)
                        ) {
                            Text("Shy", fontSize = 10.sp, color = Color(0xFFF48FB1))
                        }

                        OutlinedButton(
                            onClick = {
                                AriaOverlayService.instance?.speechEngine?.ttsManager?.speakEmotionalSentences(
                                    listOf(
                                        EmotionalSentence(
                                            text = "Ooh, what's that over there? I wonder how that works!",
                                            emotion = AriaEmotion.CURIOUS,
                                            intensity = 2,
                                            effect = "none"
                                        )
                                    )
                                )
                            },
                            shape = RoundedCornerShape(8.dp),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                            modifier = Modifier.weight(1f).height(32.dp)
                        ) {
                            Text("Curious", fontSize = 10.sp, color = Color(0xFF81C784))
                        }
                    }
                }
            }
        }

        // Long-term Memory Facts
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(
                            imageVector = Icons.Default.Psychology,
                            contentDescription = null,
                            tint = Color(0xFF7C4DFF),
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Aria's Memory (${memories.size})",
                                fontWeight = FontWeight.SemiBold,
                                color = Color.White,
                                fontSize = 15.sp
                            )
                            Text(
                                text = "Facts Aria remembers across conversations",
                                fontSize = 12.sp,
                                color = Color(0xFF8B949E)
                            )
                        }
                        IconButton(onClick = { showAddMemory = !showAddMemory }) {
                            Icon(
                                imageVector = if (showAddMemory) Icons.Default.Close else Icons.Default.Add,
                                contentDescription = "Add Memory",
                                tint = Color(0xFF58A6FF)
                            )
                        }
                    }

                    AnimatedVisibility(visible = showAddMemory) {
                        Column {
                            Spacer(modifier = Modifier.height(10.dp))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                OutlinedTextField(
                                    value = newMemoryText,
                                    onValueChange = { newMemoryText = it },
                                    placeholder = { Text("e.g. My favorite drink is matcha latte", color = Color.Gray) },
                                    singleLine = true,
                                    colors = OutlinedTextFieldDefaults.colors(
                                        focusedBorderColor = Color(0xFF58A6FF),
                                        unfocusedBorderColor = Color(0xFF30363D),
                                        focusedTextColor = Color.White,
                                        unfocusedTextColor = Color.White
                                    ),
                                    modifier = Modifier.weight(1f)
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Button(
                                    onClick = {
                                        if (newMemoryText.isNotBlank()) {
                                            prefs.addMemory(newMemoryText)
                                            newMemoryText = ""
                                            showAddMemory = false
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF238636))
                                ) {
                                    Text("Save")
                                }
                            }
                        }
                    }

                    if (memories.isEmpty()) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "No stored facts yet. Tell Aria 'Remember that...' or tap + above.",
                            fontSize = 12.sp,
                            color = Color(0xFF8B949E)
                        )
                    } else {
                        Spacer(modifier = Modifier.height(10.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            memories.take(5).forEach { mem ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(Color(0xFF0D1117))
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "• ${mem.fact}",
                                        fontSize = 13.sp,
                                        color = Color.White,
                                        modifier = Modifier.weight(1f)
                                    )
                                    IconButton(
                                        onClick = { prefs.removeMemory(mem.id) },
                                        modifier = Modifier.size(20.dp)
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.Close,
                                            contentDescription = "Delete",
                                            tint = Color.Gray,
                                            modifier = Modifier.size(14.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Recent Actions Preview Card
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = "Recent Activity",
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White,
                            fontSize = 15.sp
                        )
                        Spacer(modifier = Modifier.weight(1f))
                        Text(
                            text = "View All (${history.size})",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = Color(0xFF58A6FF),
                            modifier = Modifier.clickable { onNavigateToHistory() }
                        )
                    }

                    Spacer(modifier = Modifier.height(10.dp))
                    if (history.isEmpty()) {
                        Text(
                            text = "No actions recorded yet. Aria's task executions and safety logs will appear here.",
                            fontSize = 12.sp,
                            color = Color(0xFF8B949E)
                        )
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            history.take(3).forEach { item ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(Color(0xFF0D1117))
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(4.dp))
                                            .background(Color(0xFF21262D))
                                            .padding(horizontal = 6.dp, vertical = 2.dp)
                                    ) {
                                        Text(item.actionType, fontSize = 10.sp, color = Color(0xFF58A6FF), fontWeight = FontWeight.Bold)
                                    }
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        text = item.description,
                                        fontSize = 12.sp,
                                        color = Color.White,
                                        maxLines = 1,
                                        modifier = Modifier.weight(1f)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
