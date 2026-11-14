package com.example.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.AccessibilityNew
import androidx.compose.material.icons.outlined.BatterySaver
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.example.data.AriaPreferences
import com.example.model.AriaEmotion
import com.example.model.AvatarState
import com.example.service.AriaAccessibilityService
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaBorderStrong
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPinkRedGradient
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaSuccess
import com.example.ui.theme.AriaText
import kotlinx.coroutines.launch

@Composable
fun OnboardingScreen(
    prefs: AriaPreferences,
    onFinish: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pagerState = rememberPagerState(pageCount = { 4 })

    var hasOverlay by remember {
        mutableStateOf(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(context) else true)
    }
    var hasAccessibility by remember {
        mutableStateOf(AriaAccessibilityService.isRunning)
    }
    var hasMic by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
    }
    var hasBatteryExempt by remember {
        mutableStateOf(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                pm.isIgnoringBatteryOptimizations(context.packageName)
            } else true
        )
    }

    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasMic = granted
    }

    LaunchedEffect(Unit) {
        while (true) {
            hasOverlay = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(context) else true
            hasAccessibility = AriaAccessibilityService.isRunning
            hasMic = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            kotlinx.coroutines.delay(1000)
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // Skip Button & Top indicator
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            // Step dots indicator
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                repeat(4) { index ->
                    val isCurrent = pagerState.currentPage == index
                    Box(
                        modifier = Modifier
                            .height(8.dp)
                            .width(if (isCurrent) 24.dp else 8.dp)
                            .clip(CircleShape)
                            .background(if (isCurrent) AriaPrimary else AriaBorder)
                    )
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            if (pagerState.currentPage < 3) {
                TextButton(onClick = {
                    prefs.hasCompletedOnboarding = true
                    onFinish()
                }) {
                    Text("Skip", color = AriaMutedText, fontSize = 13.sp)
                }
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Swipeable Pager
        HorizontalPager(
            state = pagerState,
            modifier = Modifier.weight(1f)
        ) { page ->
            when (page) {
                0 -> OnboardingStepWelcome()
                1 -> OnboardingStepOverlay(hasOverlay = hasOverlay) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        val intent = Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:${context.packageName}")
                        )
                        context.startActivity(intent)
                    }
                }
                2 -> OnboardingStepAccessibility(hasAccessibility = hasAccessibility) {
                    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    context.startActivity(intent)
                }
                3 -> OnboardingStepSensors(
                    hasMic = hasMic,
                    hasBattery = hasBatteryExempt,
                    onRequestMic = { micLauncher.launch(Manifest.permission.RECORD_AUDIO) },
                    onRequestBattery = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            try {
                                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                    data = Uri.parse("package:${context.packageName}")
                                }
                                context.startActivity(intent)
                            } catch (e: Exception) {
                                context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                            }
                        }
                    }
                )
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Navigation bottom button
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            if (pagerState.currentPage > 0) {
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            pagerState.animateScrollToPage(pagerState.currentPage - 1)
                        }
                    },
                    shape = RoundedCornerShape(14.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, AriaBorder),
                    modifier = Modifier.height(48.dp)
                ) {
                    Text("Back", color = AriaText)
                }
                Spacer(modifier = Modifier.width(12.dp))
            }

            Button(
                onClick = {
                    if (pagerState.currentPage < 3) {
                        scope.launch {
                            pagerState.animateScrollToPage(pagerState.currentPage + 1)
                        }
                    } else {
                        prefs.hasCompletedOnboarding = true
                        onFinish()
                    }
                },
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp)
                    .background(AriaPinkRedGradient, RoundedCornerShape(14.dp))
            ) {
                Text(
                    text = if (pagerState.currentPage < 3) "Continue" else "Get Started with Aria",
                    fontWeight = FontWeight.Bold,
                    color = Color.White
                )
                Spacer(modifier = Modifier.width(8.dp))
                Icon(
                    imageVector = Icons.AutoMirrored.Outlined.ArrowForward,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(18.dp)
                )
            }
        }
    }
}

@Composable
private fun OnboardingStepWelcome() {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        AriaAvatarComponent(
            state = AvatarState.LISTENING,
            emotion = AriaEmotion.EXCITED,
            size = 140.dp
        )
        Spacer(modifier = Modifier.height(24.dp))
        Text(
            text = "Meet Aria",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = AriaText
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Your playful, cheerful AI voice companion floating over your phone. She can read your screen and help you automate everyday tasks.",
            fontSize = 14.sp,
            color = AriaMutedText,
            textAlign = TextAlign.Center,
            lineHeight = 20.sp,
            modifier = Modifier.padding(horizontal = 16.dp)
        )
    }
}

@Composable
private fun OnboardingStepOverlay(
    hasOverlay: Boolean,
    onGrant: () -> Unit
) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(
            modifier = Modifier
                .size(90.dp)
                .clip(CircleShape)
                .background(AriaDarkSurfaceElevated)
                .border(1.5.dp, if (hasOverlay) AriaSuccess else AriaPrimary, CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Outlined.Layers,
                contentDescription = null,
                tint = if (hasOverlay) AriaSuccess else AriaPrimary,
                modifier = Modifier.size(42.dp)
            )
        }
        Spacer(modifier = Modifier.height(20.dp))
        Text(
            text = "Floating Avatar Overlay",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color = AriaText
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Allows Aria to float seamlessly over all your Android apps so you can summon her anytime with your voice or a single tap.",
            fontSize = 13.sp,
            color = AriaMutedText,
            textAlign = TextAlign.Center,
            lineHeight = 19.sp,
            modifier = Modifier.padding(horizontal = 16.dp)
        )
        Spacer(modifier = Modifier.height(20.dp))

        if (hasOverlay) {
            GrantedBadge()
        } else {
            Button(
                onClick = onGrant,
                colors = ButtonDefaults.buttonColors(containerColor = AriaDarkSurfaceElevated),
                border = androidx.compose.foundation.BorderStroke(1.dp, AriaPrimary),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("Grant Overlay Permission", color = AriaPrimary, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun OnboardingStepAccessibility(
    hasAccessibility: Boolean,
    onGrant: () -> Unit
) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(
            modifier = Modifier
                .size(90.dp)
                .clip(CircleShape)
                .background(AriaDarkSurfaceElevated)
                .border(1.5.dp, if (hasAccessibility) AriaSuccess else AriaAccent, CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Outlined.AccessibilityNew,
                contentDescription = null,
                tint = if (hasAccessibility) AriaSuccess else AriaAccent,
                modifier = Modifier.size(42.dp)
            )
        }
        Spacer(modifier = Modifier.height(20.dp))
        Text(
            text = "Screen Awareness & Tasks",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color = AriaText
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Allows Aria to understand what's on your screen in real time and execute taps or gestures. Volatile in RAM only—never saved to disk, with automatic banking shields.",
            fontSize = 13.sp,
            color = AriaMutedText,
            textAlign = TextAlign.Center,
            lineHeight = 19.sp,
            modifier = Modifier.padding(horizontal = 16.dp)
        )
        Spacer(modifier = Modifier.height(20.dp))

        if (hasAccessibility) {
            GrantedBadge()
        } else {
            Button(
                onClick = onGrant,
                colors = ButtonDefaults.buttonColors(containerColor = AriaDarkSurfaceElevated),
                border = androidx.compose.foundation.BorderStroke(1.dp, AriaAccent),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("Enable in Accessibility Settings", color = AriaAccent, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun OnboardingStepSensors(
    hasMic: Boolean,
    hasBattery: Boolean,
    onRequestMic: () -> Unit,
    onRequestBattery: () -> Unit
) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "Voice & Background Service",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color = AriaText
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Listen for 'Hey Aria' hands-free and keep the floating companion active in the background.",
            fontSize = 13.sp,
            color = AriaMutedText,
            textAlign = TextAlign.Center,
            lineHeight = 19.sp,
            modifier = Modifier.padding(horizontal = 16.dp)
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Mic Row
        Card(
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
            border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(14.dp)
            ) {
                Icon(Icons.Outlined.Mic, contentDescription = null, tint = AriaPrimary, modifier = Modifier.size(22.dp))
                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text("Microphone", fontWeight = FontWeight.SemiBold, color = AriaText, fontSize = 14.sp)
                    Text("Offline voice recognition", color = AriaMutedText, fontSize = 11.sp)
                }
                if (hasMic) {
                    GrantedBadge()
                } else {
                    OutlinedButton(
                        onClick = onRequestMic,
                        shape = RoundedCornerShape(8.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, AriaPrimary)
                    ) {
                        Text("Grant", fontSize = 11.sp, color = AriaPrimary)
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(10.dp))

        // Battery Row
        Card(
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
            border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(14.dp)
            ) {
                Icon(Icons.Outlined.BatterySaver, contentDescription = null, tint = AriaAccent, modifier = Modifier.size(22.dp))
                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text("Battery Exemption", fontWeight = FontWeight.SemiBold, color = AriaText, fontSize = 14.sp)
                    Text("Prevents system sleep kills", color = AriaMutedText, fontSize = 11.sp)
                }
                if (hasBattery) {
                    GrantedBadge()
                } else {
                    OutlinedButton(
                        onClick = onRequestBattery,
                        shape = RoundedCornerShape(8.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, AriaAccent)
                    ) {
                        Text("Exempt", fontSize = 11.sp, color = AriaAccent)
                    }
                }
            }
        }
    }
}

@Composable
private fun GrantedBadge() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(AriaSuccess.copy(alpha = 0.2f))
            .padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        Icon(Icons.Outlined.Check, contentDescription = null, tint = AriaSuccess, modifier = Modifier.size(14.dp))
        Spacer(modifier = Modifier.width(4.dp))
        Text("Granted", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = AriaSuccess)
    }
}
