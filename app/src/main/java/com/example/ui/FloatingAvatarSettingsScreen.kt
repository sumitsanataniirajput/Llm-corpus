package com.example.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.OpenWith
import androidx.compose.material.icons.outlined.Opacity
import androidx.compose.material.icons.outlined.PhotoSizeSelectLarge
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.model.AriaEmotion
import com.example.model.AvatarState
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaError
import com.example.ui.theme.AriaHotPink
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaNeonViolet
import com.example.ui.theme.AriaPinkRedGradient
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaText

@Composable
fun FloatingAvatarSettingsScreen(
    prefs: AriaPreferences,
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var overlaySize by remember { mutableFloatStateOf(prefs.overlaySizeDp.toFloat()) }
    var overlayOpacity by remember { mutableFloatStateOf(prefs.overlayOpacityPercent.toFloat()) }
    var showGlowRing by remember { mutableStateOf(prefs.overlayShowGlowRing) }
    var freeMovement by remember { mutableStateOf(prefs.freeMovementEnabled) }
    var customAvatarUri by remember { mutableStateOf(prefs.customAvatarUri) }

    // Android Zero-permission Photo Picker for Custom Avatar Upload
    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri != null) {
            // Persist read permission for the selected image
            try {
                val flag = Intent.FLAG_GRANT_READ_URI_PERMISSION
                context.contentResolver.takePersistableUriPermission(uri, flag)
            } catch (e: Exception) {
                // Ignore if not supported by provider
            }
            val uriString = uri.toString()
            prefs.customAvatarUri = uriString
            customAvatarUri = uriString
        }
    }

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
                        text = "Floating Avatar & Customization",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = AriaText
                    )
                    Text(
                        text = "Upload custom avatar, move anywhere, size & opacity",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )
                }
            }
        }

        // 1. Live Preview Card
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = BorderStroke(1.dp, AriaBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "Live Avatar Preview",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = AriaMutedText
                    )
                    Spacer(modifier = Modifier.height(14.dp))
                    AriaAvatarComponent(
                        state = AvatarState.LISTENING,
                        emotion = AriaEmotion.HAPPY,
                        size = overlaySize.dp,
                        customAvatarUri = customAvatarUri
                    )
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(
                        text = if (!customAvatarUri.isNullOrBlank()) "Custom Avatar Active" else "Default Wholesome Anime Mascot",
                        fontSize = 12.sp,
                        color = if (!customAvatarUri.isNullOrBlank()) AriaAccent else AriaMutedText,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
        }

        // 2. Avatar Upload System
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = BorderStroke(1.dp, AriaBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(36.dp)
                                .clip(CircleShape)
                                .background(AriaPrimary.copy(alpha = 0.15f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.AddPhotoAlternate,
                                contentDescription = null,
                                tint = AriaPrimary,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Avatar Upload System",
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp,
                                color = AriaText
                            )
                            Text(
                                text = "Choose your own custom character image or photo",
                                fontSize = 12.sp,
                                color = AriaMutedText
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Button(
                            onClick = {
                                photoPickerLauncher.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                )
                            },
                            shape = RoundedCornerShape(12.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                            modifier = Modifier
                                .weight(1f)
                                .height(44.dp)
                                .background(AriaPinkRedGradient, RoundedCornerShape(12.dp))
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.AddPhotoAlternate,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(17.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Upload Avatar", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        }

                        if (!customAvatarUri.isNullOrBlank()) {
                            OutlinedButton(
                                onClick = {
                                    prefs.customAvatarUri = null
                                    customAvatarUri = null
                                },
                                shape = RoundedCornerShape(12.dp),
                                border = BorderStroke(1.dp, AriaError.copy(alpha = 0.5f)),
                                modifier = Modifier.height(44.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.DeleteOutline,
                                    contentDescription = "Reset",
                                    tint = AriaError,
                                    modifier = Modifier.size(17.dp)
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Text("Reset", color = AriaError, fontSize = 13.sp)
                            }
                        }
                    }
                }
            }
        }

        // 3. Free Floating Movement Anywhere Toggle
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = BorderStroke(1.dp, AriaBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(18.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .clip(CircleShape)
                            .background(AriaNeonViolet.copy(alpha = 0.15f)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.OpenWith,
                            contentDescription = null,
                            tint = AriaNeonViolet,
                            modifier = Modifier.size(20.dp)
                        )
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Free Movement Anywhere",
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp,
                            color = AriaText
                        )
                        Text(
                            text = if (freeMovement) "Drag and drop anywhere on the screen without forced snapping" else "Snaps smoothly to left or right screen edge",
                            fontSize = 12.sp,
                            color = AriaMutedText
                        )
                    }
                    Switch(
                        checked = freeMovement,
                        onCheckedChange = {
                            freeMovement = it
                            prefs.freeMovementEnabled = it
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = AriaHotPink,
                            checkedTrackColor = AriaPrimary.copy(alpha = 0.5f)
                        )
                    )
                }
            }
        }

        // 4. Overlay Size Slider
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = BorderStroke(1.dp, AriaBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Outlined.PhotoSizeSelectLarge,
                            contentDescription = null,
                            tint = AriaPrimary,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Avatar Size: ${overlaySize.toInt()} dp",
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 15.sp,
                            color = AriaText
                        )
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Customize how large the floating companion appears over other apps.",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Slider(
                        value = overlaySize,
                        onValueChange = {
                            overlaySize = it
                            prefs.overlaySizeDp = it.toInt()
                        },
                        valueRange = 64f..130f,
                        colors = SliderDefaults.colors(
                            thumbColor = AriaHotPink,
                            activeTrackColor = AriaPrimary
                        )
                    )
                }
            }
        }

        // 5. Overlay Opacity Slider
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = BorderStroke(1.dp, AriaBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Outlined.Opacity,
                            contentDescription = null,
                            tint = AriaAccent,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Opacity: ${overlayOpacity.toInt()}%",
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 15.sp,
                            color = AriaText
                        )
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Adjust transparency of the floating overlay over background apps.",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Slider(
                        value = overlayOpacity,
                        onValueChange = {
                            overlayOpacity = it
                            prefs.overlayOpacityPercent = it.toInt()
                        },
                        valueRange = 40f..100f,
                        colors = SliderDefaults.colors(
                            thumbColor = AriaHotPink,
                            activeTrackColor = AriaPrimary
                        )
                    )
                }
            }
        }

        // 6. Glow Ring Toggle
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = BorderStroke(1.dp, AriaBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(18.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.AutoAwesome,
                        contentDescription = null,
                        tint = AriaNeonViolet,
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Radiant Emotion Glow Ring",
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 14.sp,
                            color = AriaText
                        )
                        Text(
                            text = "Renders cosmic fuchsia/violet aura glow around avatar",
                            fontSize = 12.sp,
                            color = AriaMutedText
                        )
                    }
                    Switch(
                        checked = showGlowRing,
                        onCheckedChange = {
                            showGlowRing = it
                            prefs.overlayShowGlowRing = it
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = AriaHotPink,
                            checkedTrackColor = AriaPrimary.copy(alpha = 0.5f)
                        )
                    )
                }
            }
        }
    }
}
