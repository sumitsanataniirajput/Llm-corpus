package com.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material.icons.outlined.Favorite
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.example.model.AriaEmotion
import com.example.model.AvatarState
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaSuccess
import com.example.ui.theme.AriaText

@Composable
fun AboutScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Back",
                        tint = AriaText
                    )
                }
                Spacer(modifier = Modifier.width(8.dp))
                Column {
                    Text(
                        text = "About Aria",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = AriaText
                    )
                    Text(
                        text = "Version 2.0 · Wholesome AI Voice Companion",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )
                }
            }
        }

        // Hero Brand Card
        item {
            Card(
                shape = RoundedCornerShape(24.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    AriaAvatarComponent(
                        state = AvatarState.LISTENING,
                        emotion = AriaEmotion.EXCITED,
                        size = 96.dp
                    )

                    Spacer(modifier = Modifier.height(14.dp))
                    Text(
                        text = "Aria Voice Assistant",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                        color = AriaText
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Always-on Screen Reader & Voice Automation",
                        fontSize = 13.sp,
                        color = AriaPrimary,
                        fontWeight = FontWeight.SemiBold
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Engineered with strict zero-storage screen privacy, AES-256 encrypted credentials, and multi-protocol LLM silent fallback.",
                        fontSize = 12.sp,
                        color = AriaMutedText,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        lineHeight = 17.sp
                    )
                }
            }
        }

        // Core Pillars
        item {
            AboutPillarCard(
                icon = Icons.Outlined.Favorite,
                iconTint = AriaPrimary,
                title = "Wholesome & Family-Friendly",
                description = "Aria is designed as a cheerful, playful, childlike companion. Safe for all ages with strictly zero romantic or unsafe roleplay."
            )
        }

        item {
            AboutPillarCard(
                icon = Icons.Outlined.Shield,
                iconTint = AriaSecondary,
                title = "Strict Screen & Data Privacy",
                description = "Screen UI trees stay strictly in RAM and are never written to disk. Password fields, banking apps, and SMS OTPs are scrubbed automatically."
            )
        }

        item {
            AboutPillarCard(
                icon = Icons.Outlined.Psychology,
                iconTint = Color(0xFFC084FC),
                title = "Any Model, Any Provider",
                description = "No built-in models are forced. Connect your own OpenAI, Anthropic, or Gemini endpoints with custom vision models and silent cascade fallback."
            )
        }
    }
}

@Composable
private fun AboutPillarCard(
    icon: ImageVector,
    iconTint: Color,
    title: String,
    description: String
) {
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
        border = CardDefaults.outlinedCardBorder().copy(
            brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.Top
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(iconTint.copy(alpha = 0.15f))
                    .border(1.dp, iconTint.copy(alpha = 0.4f), CircleShape),
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
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp,
                    color = AriaText
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = description,
                    fontSize = 12.sp,
                    color = AriaMutedText,
                    lineHeight = 17.sp
                )
            }
        }
    }
}
