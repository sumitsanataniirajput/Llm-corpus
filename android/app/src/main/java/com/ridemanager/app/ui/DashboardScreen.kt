package com.ridemanager.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ridemanager.app.AppViewModel
import com.ridemanager.app.data.dateTime
import com.ridemanager.app.data.money
import com.ridemanager.app.data.objects
import com.ridemanager.app.data.str
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

/** Today's numbers and the alerts that need attention. Refreshes every 60 seconds while visible. */
@Composable
fun DashboardScreen(vm: AppViewModel) {
    var stats by remember { mutableStateOf<JSONObject?>(null) }
    var alerts by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        while (true) {
            loading = true
            try {
                val from = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toOffsetDateTime()
                stats = vm.api.rpc("dashboard_stats", JSONObject().put("p_from", from.toString()).put("p_to", OffsetDateTime.now().toString()).put("p_city_id", JSONObject.NULL)) as? JSONObject
                alerts = (vm.api.rpc("operational_alerts") as? JSONArray)?.objects().orEmpty()
            } catch (e: Exception) {
                vm.fail(e)
            }
            loading = false
            delay(60_000)
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Today", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(stats?.str("generated_at")?.let { "Updated ${dateTime(it)}" } ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            IconButton(onClick = { reload++ }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())

        val s = stats
        if (s == null) {
            if (!loading) Text("No figures could be loaded.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            if (alerts.isNotEmpty()) SectionCard("Needs attention") {
                alerts.forEach { a ->
                    val color = when (a.optString("level")) { "emergency" -> Danger; "high" -> Warning; else -> MaterialTheme.colorScheme.onSurface }
                    Text("• ${a.optString("message")}", color = color, modifier = Modifier.padding(vertical = 3.dp))
                }
            }
            SectionCard("Rides") {
                KeyValue("Bookings today", s.optLong("bookings").toString())
                KeyValue("Ongoing now", s.optLong("ongoing_rides").toString())
                KeyValue("Searching for a driver", s.optLong("searching_rides").toString())
                KeyValue("Completed", s.optLong("completed_rides").toString(), Success)
                KeyValue("Cancelled", s.optLong("cancelled_rides").toString())
            }
            SectionCard("Drivers") {
                KeyValue("Online", s.optLong("online_drivers").toString(), Success)
                KeyValue("On a ride", s.optLong("drivers_on_ride").toString())
                KeyValue("Approved drivers", s.optLong("approved_drivers").toString())
                KeyValue("Applications waiting", s.optLong("pending_driver_applications").toString())
                KeyValue("Documents expiring in 30 days", s.optLong("documents_expiring_30d").toString())
            }
            if (vm.can("finance.view")) SectionCard("Money today") {
                KeyValue("Revenue", money(s.optLong("revenue_paise")))
                KeyValue("Commission", money(s.optLong("commission_paise")))
                KeyValue("Driver earnings", money(s.optLong("driver_earnings_paise")))
                KeyValue("Pending payments", "${s.optLong("pending_payments_count")} (${money(s.optLong("pending_payments_paise"))})")
                KeyValue("Payouts awaiting", money(s.optLong("payouts_awaiting_paise")))
            }
            SectionCard("Safety and support") {
                val emergencies = s.optLong("open_emergencies")
                KeyValue("Open emergencies", emergencies.toString(), if (emergencies > 0) Danger else Color.Unspecified)
                KeyValue("Open tracking alerts", s.optLong("open_tracking_alerts").toString())
                KeyValue("Open tickets", s.optLong("open_tickets").toString())
                KeyValue("Distance discrepancies", s.optLong("open_distance_discrepancies").toString())
            }
        }
    }
}
