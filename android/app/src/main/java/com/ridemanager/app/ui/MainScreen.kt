package com.ridemanager.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Place
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import com.ridemanager.app.AppViewModel
import com.ridemanager.app.UiState

private data class Tab(val id: String, val label: String, val icon: ImageVector, val permission: String?)

private val TABS = listOf(
    Tab("home", "Home", Icons.Filled.Home, "dashboard.view"),
    Tab("rides", "Rides", Icons.AutoMirrored.Filled.List, "rides.view"),
    Tab("map", "Map", Icons.Filled.Place, "tracking.view"),
    Tab("alerts", "Alerts", Icons.Filled.Notifications, null),
    Tab("account", "Account", Icons.Filled.Person, null),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(vm: AppViewModel, state: UiState) {
    // Tabs the signed-in role may not use are hidden; the server refuses the data anyway.
    val tabs = remember(state.permissions) { TABS.filter { it.permission == null || it.permission in state.permissions } }
    var current by rememberSaveable { mutableStateOf(tabs.first().id) }
    if (tabs.none { it.id == current }) current = tabs.first().id
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(state.error, state.notice) {
        val message = state.error ?: state.notice
        if (message != null) { snackbar.showSnackbar(message); vm.clearMessages() }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text(tabs.first { it.id == current }.let { if (it.id == "home") state.appName else it.label }) }) },
        bottomBar = {
            NavigationBar {
                tabs.forEach { tab ->
                    NavigationBarItem(
                        selected = tab.id == current, onClick = { current = tab.id },
                        icon = { Icon(tab.icon, contentDescription = null) }, label = { Text(tab.label) },
                    )
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (current) {
                "home" -> DashboardScreen(vm)
                "rides" -> RidesScreen(vm)
                "map" -> MapScreen(vm)
                "alerts" -> AlertsScreen(vm)
                else -> AccountScreen(vm, state)
            }
        }
    }
}
