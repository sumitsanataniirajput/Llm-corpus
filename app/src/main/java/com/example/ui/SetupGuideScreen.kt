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
import androidx.compose.material.icons.filled.AccessibilityNew
import androidx.compose.material.icons.filled.BatterySaver
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.RocketLaunch
import androidx.compose.material.icons.filled.Warning
import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.example.data.AriaPreferences
import com.example.service.AriaAccessibilityService
import com.example.service.AriaOverlayService

import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaText

@Composable
fun SetupGuideScreen(
    prefs: AriaPreferences,
    onSetupComplete: () -> Unit,
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current

    var hasMicPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
    }

    var hasNotificationPermission by remember {
        mutableStateOf(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            } else true
        )
    }

    var hasOverlayPermission by remember {
        mutableStateOf(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(context) else true)
    }

    var isAccessibilityEnabled by remember {
        mutableStateOf(AriaAccessibilityService.isRunning)
    }

    var isBatteryOptExempt by remember {
        mutableStateOf(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
                pm?.isIgnoringBatteryOptimizations(context.packageName) == true
            } else true
        )
    }

    var startOnBoot by remember { mutableStateOf(prefs.startOnBoot) }

    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasMicPermission = granted
    }

    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasNotificationPermission = granted
    }

    // Refresh permissions on resume / launch
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            hasOverlayPermission = Settings.canDrawOverlays(context)
            val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            isBatteryOptExempt = pm?.isIgnoringBatteryOptimizations(context.packageName) == true
        }
        isAccessibilityEnabled = AriaAccessibilityService.isRunning
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = AriaDarkSurface
                ),
                shape = RoundedCornerShape(20.dp),
                border = BorderStroke(1.dp, AriaBorder)
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (onBack != null) {
                            IconButton(onClick = onBack) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                                    contentDescription = "Back",
                                    tint = AriaText
                                )
                            }
                            Spacer(modifier = Modifier.width(6.dp))
                        }
                        Text(
                            text = "Permissions & Checklist",
                            style = MaterialTheme.typography.titleLarge,
                            color = AriaText,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = "Complete these essential Android permissions to allow Aria to float over other apps, read the screen, and execute automated tasks smoothly.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = AriaMutedText
                    )
                }
            }
        }

        // 1. Microphone Permission
        item {
            PermissionStepCard(
                title = "1. Microphone",
                description = "Required for always-listening offline wake phrase ('Hey Aria') and voice commands.",
                icon = Icons.Default.Mic,
                isGranted = hasMicPermission,
                onActionClick = {
                    micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                }
            )
        }

        // 2. Overlay Window (SYSTEM_ALERT_WINDOW)
        item {
            PermissionStepCard(
                title = "2. Floating Overlay Window",
                description = "Allows Aria's animated avatar to float over other apps on your screen with edge snapping.",
                icon = Icons.Default.Layers,
                isGranted = hasOverlayPermission,
                onActionClick = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        val intent = Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:${context.packageName}")
                        )
                        context.startActivity(intent)
                    }
                }
            )
        }

        // 3. Accessibility Service
        item {
            PermissionStepCard(
                title = "3. Accessibility Service",
                description = "Enables Aria to inspect the UI tree, read screens, and perform gestures (tap, swipe, type).",
                icon = Icons.Default.AccessibilityNew,
                isGranted = isAccessibilityEnabled,
                actionLabel = if (isAccessibilityEnabled) "Active" else "Enable in Settings",
                onActionClick = {
                    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    context.startActivity(intent)
                }
            )
        }

        // 4. Notifications
        item {
            PermissionStepCard(
                title = "4. Notifications",
                description = "Keeps Aria running reliably in the background via a persistent foreground service.",
                icon = Icons.Default.Notifications,
                isGranted = hasNotificationPermission,
                onActionClick = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }
            )
        }

        // 5. Battery Optimization Exemption
        item {
            PermissionStepCard(
                title = "5. Battery Optimization Exemption",
                description = "Prevents Android Doze mode from killing the background listener when phone is locked.",
                icon = Icons.Default.BatterySaver,
                isGranted = isBatteryOptExempt,
                actionLabel = if (isBatteryOptExempt) "Exempted" else "Request Exemption",
                onActionClick = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        try {
                            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                data = Uri.parse("package:${context.packageName}")
                            }
                            context.startActivity(intent)
                        } catch (e: Exception) {
                            val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                            context.startActivity(fallback)
                        }
                    }
                }
            )
        }

        // 6. Start on Boot Toggle
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .clip(CircleShape)
                            .background(Color(0xFF21262D)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.PowerSettingsNew,
                            contentDescription = "Boot Start",
                            tint = Color(0xFF58A6FF)
                        )
                    }
                    Spacer(modifier = Modifier.width(14.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "6. Start on Boot",
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White,
                            fontSize = 15.sp
                        )
                        Text(
                            text = "Automatically launch Aria when device restarts",
                            fontSize = 13.sp,
                            color = Color(0xFF8B949E)
                        )
                    }
                    Switch(
                        checked = startOnBoot,
                        onCheckedChange = {
                            startOnBoot = it
                            prefs.startOnBoot = it
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = Color.White,
                            checkedTrackColor = Color(0xFF238636)
                        )
                    )
                }
            }
        }

        // Launch Aria Floating Assistant Button
        item {
            Spacer(modifier = Modifier.height(10.dp))
            Button(
                onClick = {
                    if (hasOverlayPermission) {
                        AriaOverlayService.start(context)
                    }
                    onSetupComplete()
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF238636)
                ),
                shape = RoundedCornerShape(16.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.RocketLaunch,
                    contentDescription = "Launch",
                    tint = Color.White
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Start Aria Floating Assistant",
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    color = Color.White
                )
            }
            Spacer(modifier = Modifier.height(20.dp))
        }
    }
}

@Composable
private fun PermissionStepCard(
    title: String,
    description: String,
    icon: ImageVector,
    isGranted: Boolean,
    actionLabel: String = if (isGranted) "Granted" else "Grant Permission",
    onActionClick: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = Color(0xFF161B22)
        )
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(
                            if (isGranted) Color(0xFF238636).copy(alpha = 0.2f)
                            else Color(0xFFD29922).copy(alpha = 0.2f)
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = if (isGranted) Icons.Default.Check else icon,
                        contentDescription = title,
                        tint = if (isGranted) Color(0xFF3FB950) else Color(0xFFE3B341),
                        modifier = Modifier.size(22.dp)
                    )
                }

                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = title,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                        fontSize = 15.sp
                    )
                    Text(
                        text = if (isGranted) "Ready" else "Action needed",
                        fontSize = 12.sp,
                        color = if (isGranted) Color(0xFF3FB950) else Color(0xFFE3B341)
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = description,
                fontSize = 13.sp,
                color = Color(0xFF8B949E),
                lineHeight = 18.sp
            )

            Spacer(modifier = Modifier.height(12.dp))
            if (isGranted) {
                OutlinedButton(
                    onClick = onActionClick,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Icon(Icons.Default.Check, contentDescription = null, tint = Color(0xFF3FB950), modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(text = "Granted", color = Color(0xFF3FB950))
                }
            } else {
                FilledTonalButton(
                    onClick = onActionClick,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.filledTonalButtonColors(
                        containerColor = Color(0xFF1F6FEB),
                        contentColor = Color.White
                    )
                ) {
                    Text(text = actionLabel, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
