package com.ridemanager.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.ridemanager.app.AppViewModel
import com.ridemanager.app.BuildConfig
import com.ridemanager.app.UiState
import com.ridemanager.app.push.Push
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun AccountScreen(vm: AppViewModel, state: UiState) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var working by remember { mutableStateOf(false) }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.registerPush() else vm.notify("Alerts stay off. You can allow notifications later in the phone's settings.")
    }

    fun attendance(action: String, done: String) {
        working = true
        scope.launch {
            try {
                vm.api.rpc("staff_attendance", JSONObject().put("p_action", action))
                vm.notify(done)
            } catch (e: Exception) {
                vm.fail(e)
            }
            working = false
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard("Signed in as") {
            KeyValue("Name", state.staff?.name ?: "—")
            KeyValue("Role", state.staff?.role ?: "—")
            KeyValue("Employee ID", state.staff?.employeeCode ?: "—")
            KeyValue("E-mail", state.staff?.email ?: "—")
        }
        SectionCard("Attendance") {
            Text("Record the start and end of your shift. Your location is not recorded.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { attendance("check_in", "Checked in.") }, enabled = !working, modifier = Modifier.weight(1f)) { Text("Check in") }
                OutlinedButton(onClick = { attendance("check_out", "Checked out.") }, enabled = !working, modifier = Modifier.weight(1f)) { Text("Check out") }
            }
        }
        SectionCard("Alerts on this phone") {
            KeyValue("Push notifications", state.pushStatus)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = {
                if (Build.VERSION.SDK_INT >= 33 && !Push.permitted(context)) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS) else vm.registerPush()
            }) { Text("Turn on alerts") }
        }
        SectionCard("About") {
            KeyValue("App version", BuildConfig.VERSION_NAME)
            Text(
                "This app is a companion to the web console: live figures, rides, the driver map, OTP status and alerts. " +
                    "Setting up drivers, prices, payouts and staff is done on the web console.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Button(
            onClick = { vm.signOut() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
        ) { Text("Sign out") }
    }
}
