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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.BatteryAlert
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.service.AriaAccessibilityService
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaText

@Composable
fun SafetyScreen(
    prefs: AriaPreferences,
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    var screenAwarenessEnabled by remember { mutableStateOf(prefs.screenAwarenessEnabled) }
    var minBatteryThreshold by remember { mutableIntStateOf(prefs.minBatteryThreshold) }

    val ignoredApps by prefs.ignoredAppsState.collectAsState()
    var newIgnoredApp by remember { mutableStateOf("") }

    val isAwarenessActive by AriaAccessibilityService.isAwarenessActive.collectAsState()

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Header
        item {
            Column {
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
                    Icon(
                        imageVector = Icons.Default.Shield,
                        contentDescription = null,
                        tint = AriaPrimary,
                        modifier = Modifier.size(28.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Screen Awareness & Privacy",
                        style = MaterialTheme.typography.titleLarge,
                        color = AriaText,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Aria protects your screen data, banking apps, and passwords with hardware-level privacy standards.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AriaMutedText
                )
            }
        }

        // Always-On Screen Awareness Configuration Card
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(10.dp)
                                .clip(CircleShape)
                                .background(if (isAwarenessActive) Color(0xFF00E5FF) else Color(0xFF8B949E))
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Always-On Screen Awareness",
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White,
                            fontSize = 15.sp
                        )
                        Spacer(modifier = Modifier.weight(1f))
                        Switch(
                            checked = screenAwarenessEnabled,
                            onCheckedChange = {
                                screenAwarenessEnabled = it
                                prefs.screenAwarenessEnabled = it
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Color(0xFF00E5FF),
                                checkedTrackColor = Color(0xFF00E5FF).copy(alpha = 0.4f)
                            )
                        )
                    }

                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Keeps the latest compact UI tree of the foreground screen in RAM only (never written to disk or action history). When you give a command, it is attached automatically so you never have to say 'read my screen'.",
                        fontSize = 12.sp,
                        color = Color(0xFF8B949E),
                        lineHeight = 17.sp
                    )

                    Spacer(modifier = Modifier.height(14.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Default.BatteryAlert,
                            contentDescription = null,
                            tint = Color(0xFFFFA000),
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "Pause awareness if battery < $minBatteryThreshold%",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White
                        )
                    }
                    Spacer(modifier = Modifier.height(6.dp))
                    Slider(
                        value = minBatteryThreshold.toFloat(),
                        onValueChange = {
                            minBatteryThreshold = it.toInt()
                            prefs.minBatteryThreshold = it.toInt()
                        },
                        valueRange = 5f..35f,
                        steps = 29,
                        colors = SliderDefaults.colors(
                            thumbColor = Color(0xFFFFA000),
                            activeTrackColor = Color(0xFFFFA000)
                        )
                    )
                    Text(
                        text = "Awareness also pauses automatically whenever the phone screen turns off.",
                        fontSize = 11.sp,
                        color = Color.Gray
                    )
                }
            }
        }

        // Ignored Apps Blacklist Card
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Default.Block,
                            contentDescription = null,
                            tint = Color(0xFFF85149),
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Ignored Apps Blacklist",
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White,
                            fontSize = 15.sp
                        )
                    }

                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = "Aria will immediately skip and never read or send content when any of these apps are in the foreground.",
                        fontSize = 12.sp,
                        color = Color(0xFF8B949E)
                    )

                    Spacer(modifier = Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = newIgnoredApp,
                            onValueChange = { newIgnoredApp = it },
                            placeholder = { Text("App package (e.g. com.example.notes)") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color(0xFFF85149),
                                unfocusedBorderColor = Color(0xFF30363D),
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            ),
                            modifier = Modifier.weight(1f)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = {
                                if (newIgnoredApp.isNotBlank()) {
                                    prefs.addIgnoredApp(newIgnoredApp.trim())
                                    newIgnoredApp = ""
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFDA3633)),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(2.dp))
                            Text("Add")
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))
                    if (ignoredApps.isEmpty()) {
                        Text("No apps in blacklist.", fontSize = 12.sp, color = Color.Gray)
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            ignoredApps.forEach { appPkg ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(Color(0xFF0D1117))
                                        .padding(horizontal = 10.dp, vertical = 6.dp)
                                ) {
                                    Text(
                                        text = appPkg,
                                        fontSize = 12.sp,
                                        fontFamily = FontFamily.Monospace,
                                        color = Color.LightGray,
                                        modifier = Modifier.weight(1f)
                                    )
                                    IconButton(
                                        onClick = { prefs.removeIgnoredApp(appPkg) },
                                        modifier = Modifier.size(24.dp)
                                    ) {
                                        Icon(
                                            Icons.Default.Close,
                                            contentDescription = "Remove",
                                            tint = Color(0xFFF85149),
                                            modifier = Modifier.size(16.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Automatic Banking & Financial Shield Card
        item {
            SafetyRuleCard(
                title = "Banking & UPI Screen Shield",
                description = "Aria automatically identifies banking apps (Google Pay, PhonePe, Paytm, Chase, Wells Fargo, etc.) and payment/credit card forms. She strictly refuses to read or process financial windows.",
                icon = Icons.Default.AccountBalance,
                accentColor = Color(0xFF388BFD)
            )
        }

        // Password & OTP Redaction Card
        item {
            SafetyRuleCard(
                title = "Zero Password & OTP Disclosure",
                description = "Input fields flagged with password or sensitive input types are scrubbed instantly. One-time verification SMS codes (OTPs) are never voiced aloud or retained.",
                icon = Icons.Default.Lock,
                accentColor = Color(0xFFD29922)
            )
        }

        // Verbal Spoken Confirmation
        item {
            SafetyRuleCard(
                title = "Verbal Spoken Confirmation",
                description = "Consequential tasks (calls, messages, buying items, deleting data) require your explicit spoken 'Yes' before execution.",
                icon = Icons.Default.RecordVoiceOver,
                accentColor = Color(0xFFD500F9)
            )
        }

        // Instant Touch Abort
        item {
            SafetyRuleCard(
                title = "Instant Touch Abort",
                description = "If you touch your phone screen with your finger or say 'Aria, stop' while she is performing gestures, all automation halts immediately.",
                icon = Icons.Default.PanTool,
                accentColor = Color(0xFFF85149)
            )
        }
    }
}

@Composable
private fun SafetyRuleCard(
    title: String,
    description: String,
    icon: ImageVector,
    accentColor: Color
) {
    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.Top
        ) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(CircleShape)
                    .background(accentColor.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = title,
                    tint = accentColor,
                    modifier = Modifier.size(22.dp)
                )
            }

            Spacer(modifier = Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                    fontSize = 15.sp
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = description,
                    fontSize = 13.sp,
                    color = Color(0xFF8B949E),
                    lineHeight = 18.sp
                )
            }
        }
    }
}
