package com.ridemanager.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ridemanager.app.AppViewModel
import com.ridemanager.app.data.dateTime
import com.ridemanager.app.data.label
import com.ridemanager.app.data.money
import com.ridemanager.app.data.objects
import com.ridemanager.app.data.str
import kotlinx.coroutines.launch
import org.json.JSONObject

private const val ONGOING = "BOOKING_CREATED,DRIVER_SEARCHING,DRIVER_ASSIGNED,DRIVER_ACCEPTED,DRIVER_ARRIVING,DRIVER_AT_PICKUP,OTP_PENDING,OTP_VERIFIED,RIDE_STARTED,RIDE_COMPLETED,PAYMENT_PENDING"
private const val LIST_COLUMNS = "id,booking_code,status,pickup_address,drop_address,booked_distance_km,estimated_fare_paise,total_fare_paise,payment_status,is_emergency,created_at"

fun statusColor(status: String): Color = when (status) {
    "CANCELLED" -> Color(0xFF64748B)
    "DISPUTED" -> Danger
    "PAYMENT_COMPLETED" -> Success
    "PAYMENT_PENDING", "OTP_PENDING", "DRIVER_SEARCHING" -> Warning
    else -> Brand
}

@Composable
fun RidesScreen(vm: AppViewModel) {
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    val id = openId
    if (id != null) RideDetail(vm, id) { openId = null } else RideList(vm) { openId = it }
}

@Composable
private fun RideList(vm: AppViewModel, onOpen: (String) -> Unit) {
    var filter by rememberSaveable { mutableStateOf("ongoing") }
    var rows by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(filter, reload) {
        loading = true
        try {
            val where = when (filter) {
                "ongoing" -> "&status=in.($ONGOING)"
                "cancelled" -> "&status=eq.CANCELLED"
                "disputed" -> "&status=eq.DISPUTED"
                else -> ""
            }
            rows = vm.api.select("bookings", "select=$LIST_COLUMNS$where&order=created_at.desc&limit=50").objects()
        } catch (e: Exception) {
            vm.fail(e)
        }
        loading = false
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("ongoing" to "Ongoing", "all" to "Latest", "cancelled" to "Cancelled", "disputed" to "Disputed").forEach { (key, text) ->
                FilterChip(selected = filter == key, onClick = { filter = key }, label = { Text(text) })
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { reload++ }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (!loading && rows.isEmpty()) MessageScreen("No rides", "Nothing matches this filter right now.")
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(rows, key = { it.optString("id") }) { b ->
                SectionCard(modifier = Modifier.clickable { onOpen(b.optString("id")) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(b.optString("booking_code"), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        if (b.optBoolean("is_emergency")) { Pill("EMERGENCY", Danger); Spacer(Modifier.padding(2.dp)) }
                        Pill(label(b.optString("status")), statusColor(b.optString("status")))
                    }
                    Spacer(Modifier.height(6.dp))
                    Text("From: ${b.optString("pickup_address")}", style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    Text("To: ${b.optString("drop_address")}", style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    Spacer(Modifier.height(4.dp))
                    val fare = if (b.isNull("total_fare_paise")) b.optLong("estimated_fare_paise") else b.optLong("total_fare_paise")
                    Text("${dateTime(b.str("created_at"))} · ${b.optString("booked_distance_km")} km · ${money(fare)}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun RideDetail(vm: AppViewModel, id: String, onBack: () -> Unit) {
    var booking by remember { mutableStateOf<JSONObject?>(null) }
    var otp by remember { mutableStateOf<JSONObject?>(null) }
    var driver by remember { mutableStateOf<JSONObject?>(null) }
    var customer by remember { mutableStateOf<JSONObject?>(null) }
    var loading by remember { mutableStateOf(true) }
    var reload by remember { mutableIntStateOf(0) }
    var confirmResend by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(id, reload) {
        loading = true
        try {
            val b = vm.api.select("bookings", "select=*&id=eq.$id&limit=1").objects().firstOrNull()
            booking = b
            if (b != null) {
                // Each extra read is optional: a role without that permission simply does not see the block.
                otp = if (vm.can("otp.view")) runCatching { vm.api.select("ride_otp_overview", "select=*&booking_id=eq.$id&order=created_at.desc&limit=1").objects().firstOrNull() }.getOrNull() else null
                driver = b.str("driver_id")?.let { d -> runCatching { vm.api.select("drivers", "select=full_name,driver_code,phone&id=eq.$d&limit=1").objects().firstOrNull() }.getOrNull() }
                customer = b.str("customer_id")?.let { c -> runCatching { vm.api.select("customer_directory", "select=full_name,phone&id=eq.$c&limit=1").objects().firstOrNull() }.getOrNull() }
            }
        } catch (e: Exception) {
            vm.fail(e)
        }
        loading = false
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to the list") }
            Text(booking?.optString("booking_code") ?: "Ride", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconButton(onClick = { reload++ }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        val b = booking
        if (b == null) {
            if (!loading) Text("This ride could not be found, or your role cannot view it.")
            return@Column
        }
        SectionCard("Trip") {
            KeyValue("Status", label(b.optString("status")), statusColor(b.optString("status")))
            KeyValue("Pickup", b.optString("pickup_address"))
            KeyValue("Drop", b.optString("drop_address"))
            KeyValue("Booked distance", "${b.optString("booked_distance_km")} km")
            b.str("actual_distance_km")?.let { KeyValue("Travelled (GPS)", "$it km") }
            KeyValue("Created", dateTime(b.str("created_at")))
            b.str("started_at")?.let { KeyValue("Started", dateTime(it)) }
            b.str("completed_at")?.let { KeyValue("Completed", dateTime(it)) }
            b.str("cancellation_reason")?.let { KeyValue("Cancelled because", it) }
        }
        SectionCard("People") {
            KeyValue("Customer", customer?.optString("full_name") ?: "—")
            customer?.str("phone")?.let { KeyValue("Customer phone", it) }
            KeyValue("Driver", driver?.let { "${it.optString("full_name")} (${it.optString("driver_code")})" } ?: "Not assigned")
            driver?.str("phone")?.let { KeyValue("Driver phone", it) }
        }
        SectionCard("Fare") {
            KeyValue("Estimate", money(b.optLong("estimated_fare_paise")))
            if (!b.isNull("total_fare_paise")) KeyValue("Final fare", money(b.optLong("total_fare_paise")))
            KeyValue("Payment", "${label(b.str("payment_method"))} · ${label(b.str("payment_status"))}")
        }
        val o = otp
        if (vm.can("otp.view")) SectionCard("Ride-start OTP") {
            if (o == null) {
                Text("No OTP has been issued for this ride yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                KeyValue("OTP status", label(o.optString("status")), if (o.optString("status") == "locked") Danger else Color.Unspecified)
                KeyValue("Expires", dateTime(o.str("expires_at")))
                KeyValue("Wrong attempts", "${o.optInt("attempt_count")} of ${o.optInt("max_attempts")}")
                KeyValue("Last SMS result", label(o.str("last_delivery_status")), if (o.str("last_delivery_status") in listOf("failed", "not_configured")) Danger else Color.Unspecified)
                KeyValue("Times sent", o.optInt("delivery_count").toString())
            }
            Text("The code itself is never shown to staff. Only the customer receives it.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val canResend = vm.can("otp.deliver") && b.optString("status") in listOf("DRIVER_ACCEPTED", "DRIVER_ARRIVING", "DRIVER_AT_PICKUP", "OTP_PENDING")
            if (canResend) {
                Spacer(Modifier.height(8.dp))
                Button(onClick = { confirmResend = true }, enabled = !sending) { Text(if (sending) "Sending…" else "Send a new OTP to the customer") }
            }
        }
    }

    if (confirmResend) AlertDialog(
        onDismissRequest = { confirmResend = false },
        title = { Text("Send a new OTP?") },
        text = { Text("The previous code stops working and a new one is sent to the customer by SMS. This is recorded in the OTP audit log under your name.") },
        confirmButton = {
            TextButton(onClick = {
                confirmResend = false; sending = true
                scope.launch {
                    try {
                        val r = vm.api.function("otp", JSONObject().put("action", "resend").put("booking_id", id))
                        val delivery = r.optJSONObject("delivery")?.optString("status").orEmpty()
                        vm.notify(if (delivery == "sent" || delivery == "delivered" || delivery == "queued") "New OTP sent to the customer." else "New OTP created, but the SMS was not sent (${label(delivery)}). Check the SMS provider.")
                    } catch (e: Exception) {
                        vm.fail(e)
                    }
                    sending = false; reload++
                }
            }) { Text("Send") }
        },
        dismissButton = { TextButton(onClick = { confirmResend = false }) { Text("Cancel") } },
    )
}
