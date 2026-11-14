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
import androidx.compose.material.icons.outlined.Animation
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import com.example.ui.theme.AriaPinkRedGradient
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaText

@Composable
fun AppearanceScreen(
    prefs: AriaPreferences,
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    var isDarkMode by remember { mutableStateOf(prefs.isDarkMode) }
    var reduceAnimations by remember { mutableStateOf(prefs.reduceAnimations) }

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
                        text = "Appearance & Theme",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = AriaText
                    )
                    Text(
                        text = "Pink & red Material 3 aesthetic, dark mode, and motion controls",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )
                }
            }
        }

        // Color Palette Showcase
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
                            imageVector = Icons.Outlined.Palette,
                            contentDescription = null,
                            tint = AriaPrimary,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Theme Palette",
                            fontWeight = FontWeight.Bold,
                            color = AriaText,
                            fontSize = 14.sp
                        )
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        PaletteSwatch("Near Black", Color(0xFF0E0A10))
                        PaletteSwatch("Plum Surface", Color(0xFF1A1220))
                        PaletteSwatch("Hot Pink", AriaPrimary)
                        PaletteSwatch("Crimson", AriaSecondary)
                        PaletteSwatch("Soft Rose", AriaAccent)
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(36.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(AriaPinkRedGradient),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "Primary Gradient (Hot Pink to Crimson Red)",
                            color = Color.White,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }

        // Dark Mode Toggle
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(16.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.DarkMode,
                        contentDescription = null,
                        tint = AriaPrimary,
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Dark Mode",
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 14.sp,
                            color = AriaText
                        )
                        Text(
                            text = "Deep plum near-black theme with high-contrast text",
                            fontSize = 12.sp,
                            color = AriaMutedText
                        )
                    }
                    Switch(
                        checked = isDarkMode,
                        onCheckedChange = {
                            isDarkMode = it
                            prefs.isDarkMode = it
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = AriaPrimary,
                            checkedTrackColor = AriaPrimary.copy(alpha = 0.4f)
                        )
                    )
                }
            }
        }

        // Reduce Animations Toggle
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(16.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Animation,
                        contentDescription = null,
                        tint = AriaAccent,
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Reduce Animations",
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 14.sp,
                            color = AriaText
                        )
                        Text(
                            text = "Minimizes particle and pulse effects for battery optimization",
                            fontSize = 12.sp,
                            color = AriaMutedText
                        )
                    }
                    Switch(
                        checked = reduceAnimations,
                        onCheckedChange = {
                            reduceAnimations = it
                            prefs.reduceAnimations = it
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = AriaPrimary,
                            checkedTrackColor = AriaPrimary.copy(alpha = 0.4f)
                        )
                    )
                }
            }
        }
    }
}

@Composable
private fun PaletteSwatch(label: String, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(color)
                .border(1.dp, AriaBorder, CircleShape)
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(text = label, fontSize = 10.sp, color = AriaMutedText)
    }
}
