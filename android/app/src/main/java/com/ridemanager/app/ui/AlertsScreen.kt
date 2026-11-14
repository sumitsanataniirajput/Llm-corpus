package com.ridemanager.app.ui

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ridemanager.app.AppViewModel
import com.ridemanager.app.data.ApiException
import com.ridemanager.app.data.ago
import com.ridemanager.app.data.label
import com.ridemanager.app.data.objects
import com.ridemanager.app.data.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.OffsetDateTime

/** Open safety incidents (with one-tap acknowledge) and the notifications addressed to this staff member. */
@Composable
fun AlertsScreen(vm: AppViewModel) {
    var incidents by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var notifications by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var reload by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val seeIncidents = vm.can("safety.view")

    LaunchedEffect(reload) {
        while (true) {
            loading = true
            try {
                if (seeIncidents) incidents = vm.api.select("safety_incidents",
                    "select=id,incident_code,incident_type,severity,status,description,created_at,acknowledged_at&status=in.(open,acknowledged,investigating)&order=created_at.desc&limit=30").objects()
                notifications = vm.api.select("notifications", "select=id,title,body,priority,category,created_at&order=created_at.desc&limit=30").objects()
            } catch (e: Exception) {
                vm.fail(e)
            }
            loading = false
            delay(30_000)
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Refreshes every 30 seconds", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            IconButton(onClick = { reload++ }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())

        if (seeIncidents) {
            Text("Safety incidents", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            if (incidents.isEmpty() && !loading) Text("No open incidents.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            incidents.forEach { i ->
                SectionCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("${i.optString("incident_code")} · ${label(i.optString("incident_type"))}", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Pill(label(i.optString("severity")), if (i.optString("severity") in listOf("critical", "high")) Danger else Warning)
                    }
                    i.str("description")?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    Text("${label(i.optString("status"))} · reported ${ago(i.str("created_at"))}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (i.optString("status") == "open" && vm.can("safety.manage")) {
                        Spacer(Modifier.height(8.dp))
                        OutlinedButton(onClick = {
                            scope.launch {
                                try {
                                    val changed = vm.api.update("safety_incidents", "id=eq.${i.optString("id")}&status=eq.open",
                                        JSONObject().put("status", "acknowledged").put("acknowledged_at", OffsetDateTime.now().toString()))
                                    if (changed.length() == 0) throw ApiException("NOT_CHANGED", "Someone else already acknowledged this incident.")
                                    vm.notify("Incident acknowledged. Continue the investigation on the web console.")
                                } catch (e: Exception) {
                                    vm.fail(e)
                                }
                                reload++
                            }
                        }) { Text("Acknowledge") }
                    }
                }
            }
        }

        Text("Notifications", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (notifications.isEmpty() && !loading) Text("No notifications.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        notifications.forEach { n ->
            SectionCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(n.optString("title"), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    if (n.optString("priority") == "emergency") Pill("Emergency", Danger)
                }
                Text(n.optString("body"), style = MaterialTheme.typography.bodyMedium)
                Text("${label(n.optString("category"))} · ${ago(n.str("created_at"))}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
