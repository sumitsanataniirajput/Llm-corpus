package com.example

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.example.data.AriaPreferences
import com.example.service.AriaOverlayService
import com.example.ui.AboutScreen
import com.example.ui.ActivityScreen
import com.example.ui.AppearanceScreen
import com.example.ui.ChatScreen
import com.example.ui.FloatingAvatarSettingsScreen
import com.example.ui.HomeScreen
import com.example.ui.ModelsScreen
import com.example.ui.OnboardingScreen
import com.example.ui.SafetyScreen
import com.example.ui.SettingsDestination
import com.example.ui.SettingsScreen
import com.example.ui.SetupGuideScreen
import com.example.ui.VoiceSettingsScreen
import com.example.ui.WakeWordsScreen
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaTheme

enum class MainTab(val title: String, val icon: ImageVector) {
    HOME("Home", Icons.Outlined.Home),
    CHAT("Chat", Icons.Outlined.ChatBubbleOutline),
    ACTIVITY("Activity", Icons.Outlined.History),
    SETTINGS("Settings", Icons.Outlined.Settings)
}

class MainActivity : ComponentActivity() {

    private lateinit var prefs: AriaPreferences

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        prefs = AriaPreferences(this)

        setContent {
            AriaTheme(darkTheme = prefs.isDarkMode) {
                var currentTab by remember { mutableStateOf(MainTab.HOME) }
                var activeSettingsSubpage by remember { mutableStateOf<SettingsDestination?>(null) }
                var showOnboarding by remember { mutableStateOf(!prefs.hasCompletedOnboarding) }

                BackHandler(enabled = showOnboarding || activeSettingsSubpage != null || currentTab != MainTab.HOME) {
                    if (showOnboarding) {
                        showOnboarding = false
                    } else if (activeSettingsSubpage != null) {
                        activeSettingsSubpage = null
                    } else if (currentTab != MainTab.HOME) {
                        currentTab = MainTab.HOME
                    }
                }

                if (showOnboarding) {
                    OnboardingScreen(
                        prefs = prefs,
                        onFinish = { showOnboarding = false }
                    )
                } else {
                    Scaffold(
                        bottomBar = {
                            NavigationBar(
                                containerColor = AriaDarkSurface,
                                tonalElevation = 6.dp
                            ) {
                                MainTab.values().forEach { tab ->
                                    val isSelected = currentTab == tab && activeSettingsSubpage == null
                                    NavigationBarItem(
                                        selected = isSelected,
                                        onClick = {
                                            activeSettingsSubpage = null
                                            currentTab = tab
                                        },
                                        icon = {
                                            Icon(
                                                imageVector = tab.icon,
                                                contentDescription = tab.title
                                            )
                                        },
                                        label = {
                                            Text(
                                                text = tab.title,
                                                fontSize = 11.sp,
                                                fontWeight = if (isSelected) androidx.compose.ui.text.font.FontWeight.Bold else androidx.compose.ui.text.font.FontWeight.Normal
                                            )
                                        },
                                        colors = NavigationBarItemDefaults.colors(
                                            selectedIconColor = AriaPrimary,
                                            selectedTextColor = AriaPrimary,
                                            indicatorColor = AriaDarkSurfaceElevated,
                                            unselectedIconColor = AriaMutedText,
                                            unselectedTextColor = AriaMutedText
                                        )
                                    )
                                }
                            }
                        }
                    ) { innerPadding ->
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .background(AriaDarkBackground)
                                .padding(innerPadding)
                        ) {
                            if (activeSettingsSubpage != null) {
                                when (activeSettingsSubpage!!) {
                                    SettingsDestination.VOICE_AND_EMOTIONS -> VoiceSettingsScreen(
                                        prefs = prefs,
                                        onBack = { activeSettingsSubpage = null }
                                    )
                                    SettingsDestination.WAKE_AND_SLEEP -> WakeWordsScreen(
                                        prefs = prefs,
                                        onBack = { activeSettingsSubpage = null }
                                    )
                                    SettingsDestination.PROVIDERS_AND_MODELS -> ModelsScreen(
                                        prefs = prefs,
                                        onBack = { activeSettingsSubpage = null }
                                    )
                                    SettingsDestination.SCREEN_AWARENESS -> SafetyScreen(
                                        prefs = prefs,
                                        onBack = { activeSettingsSubpage = null }
                                    )
                                    SettingsDestination.FLOATING_AVATAR -> FloatingAvatarSettingsScreen(
                                        prefs = prefs,
                                        onBack = { activeSettingsSubpage = null }
                                    )
                                    SettingsDestination.PERMISSIONS -> SetupGuideScreen(
                                        prefs = prefs,
                                        onSetupComplete = { activeSettingsSubpage = null },
                                        onBack = { activeSettingsSubpage = null }
                                    )
                                    SettingsDestination.APPEARANCE -> AppearanceScreen(
                                        prefs = prefs,
                                        onBack = { activeSettingsSubpage = null }
                                    )
                                    SettingsDestination.ABOUT -> AboutScreen(
                                        onBack = { activeSettingsSubpage = null }
                                    )
                                }
                            } else {
                                when (currentTab) {
                                    MainTab.HOME -> HomeScreen(
                                        prefs = prefs,
                                        onNavigateToChat = { currentTab = MainTab.CHAT },
                                        onNavigateToSettings = { currentTab = MainTab.SETTINGS },
                                        onNavigateToPermissions = {
                                            currentTab = MainTab.SETTINGS
                                            activeSettingsSubpage = SettingsDestination.PERMISSIONS
                                        }
                                    )
                                    MainTab.CHAT -> ChatScreen(prefs = prefs)
                                    MainTab.ACTIVITY -> ActivityScreen(prefs = prefs)
                                    MainTab.SETTINGS -> SettingsScreen(
                                        prefs = prefs,
                                        onNavigate = { destination ->
                                            activeSettingsSubpage = destination
                                        }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            AriaOverlayService.instance?.onMicrophonePermissionGranted()
        }
    }
}
