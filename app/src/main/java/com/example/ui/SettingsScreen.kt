package com.example.ui

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForwardIos
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaText

enum class SettingsDestination {
    VOICE_AND_EMOTIONS,
    WAKE_AND_SLEEP,
    PROVIDERS_AND_MODELS,
    SCREEN_AWARENESS,
    FLOATING_AVATAR,
    PERMISSIONS,
    APPEARANCE,
    ABOUT
}

@Composable
fun SettingsScreen(
    prefs: AriaPreferences,
    onNavigate: (SettingsDestination) -> Unit,
    modifier: Modifier = Modifier
) {
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
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.headlineSmall,
                    color = AriaText,
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = "Configure voice, AI brain providers, awareness, and preferences.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AriaMutedText
                )
            }
        }

        // Section: AI Intelligence & Personality
        item {
            SettingsGroupHeader(title = "Intelligence & Voice")
        }

        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column {
                    SettingsRowItem(
                        icon = Icons.Outlined.RecordVoiceOver,
                        iconTint = AriaPrimary,
                        title = "Voice and Emotions",
                        subtitle = "Pluggable TTS (ElevenLabs, OpenAI, Gemini), childlike voice styling",
                        onClick = { onNavigate(SettingsDestination.VOICE_AND_EMOTIONS) }
                    )

                    SettingsDivider()

                    SettingsRowItem(
                        icon = Icons.Outlined.Mic,
                        iconTint = AriaAccent,
                        title = "Wake and Sleep Phrases",
                        subtitle = "Fuzzy matching: '${prefs.wakePhrase}' & '${prefs.sleepPhrase}'",
                        onClick = { onNavigate(SettingsDestination.WAKE_AND_SLEEP) }
                    )

                    SettingsDivider()

                    SettingsRowItem(
                        icon = Icons.Outlined.Psychology,
                        iconTint = Color(0xFFC084FC),
                        title = "Providers and Models",
                        subtitle = "OpenAI, Anthropic & Gemini adapters, vision models, silent fallback",
                        onClick = { onNavigate(SettingsDestination.PROVIDERS_AND_MODELS) }
                    )
                }
            }
        }

        // Section: Automation & Privacy
        item {
            SettingsGroupHeader(title = "Automation & Privacy")
        }

        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column {
                    SettingsRowItem(
                        icon = Icons.Outlined.Visibility,
                        iconTint = Color(0xFF38BDF8),
                        title = "Screen Awareness and Privacy",
                        subtitle = "Volatile UI tree in RAM, banking & password shield, ignored apps",
                        onClick = { onNavigate(SettingsDestination.SCREEN_AWARENESS) }
                    )

                    SettingsDivider()

                    SettingsRowItem(
                        icon = Icons.Outlined.Layers,
                        iconTint = AriaSecondary,
                        title = "Floating Avatar",
                        subtitle = "Overlay size, opacity, snapping physics, and glow rings",
                        onClick = { onNavigate(SettingsDestination.FLOATING_AVATAR) }
                    )

                    SettingsDivider()

                    SettingsRowItem(
                        icon = Icons.Outlined.Checklist,
                        iconTint = Color(0xFF4ADE80),
                        title = "Permissions & Onboarding",
                        subtitle = "Overlay, Accessibility, Microphone, and Battery exemptions",
                        onClick = { onNavigate(SettingsDestination.PERMISSIONS) }
                    )
                }
            }
        }

        // Section: System & App
        item {
            SettingsGroupHeader(title = "Application")
        }

        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column {
                    SettingsRowItem(
                        icon = Icons.Outlined.DarkMode,
                        iconTint = AriaAccent,
                        title = "Appearance",
                        subtitle = "Dark / Light theme mode, reduce animations toggle",
                        onClick = { onNavigate(SettingsDestination.APPEARANCE) }
                    )

                    SettingsDivider()

                    SettingsRowItem(
                        icon = Icons.Outlined.Info,
                        iconTint = AriaText,
                        title = "About Aria",
                        subtitle = "Version 2.0 · Wholesome AI Voice Companion",
                        onClick = { onNavigate(SettingsDestination.ABOUT) }
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingsGroupHeader(title: String) {
    Text(
        text = title,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        color = AriaPrimary,
        modifier = Modifier.padding(start = 4.dp, top = 4.dp)
    )
}

@Composable
private fun SettingsRowItem(
    icon: ImageVector,
    iconTint: Color,
    title: String,
    subtitle: String,
    onClick: () -> Unit
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp)
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(iconTint.copy(alpha = 0.15f))
                .border(1.dp, iconTint.copy(alpha = 0.35f), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = iconTint,
                modifier = Modifier.size(20.dp)
            )
        }

        Spacer(modifier = Modifier.width(14.dp))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
                color = AriaText
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = subtitle,
                fontSize = 12.sp,
                color = AriaMutedText,
                lineHeight = 16.sp
            )
        }

        Icon(
            imageVector = Icons.AutoMirrored.Outlined.ArrowForwardIos,
            contentDescription = null,
            tint = AriaMutedText,
            modifier = Modifier.size(14.dp)
        )
    }
}

@Composable
private fun SettingsDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .padding(horizontal = 16.dp)
            .background(AriaBorder)
    )
}
