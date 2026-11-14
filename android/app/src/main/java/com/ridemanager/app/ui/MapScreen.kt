package com.ridemanager.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapProperties
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.rememberCameraPositionState
import com.ridemanager.app.AppViewModel
import com.ridemanager.app.BuildConfig
import com.ridemanager.app.data.label
import com.ridemanager.app.data.objects
import kotlinx.coroutines.delay
import org.json.JSONObject

private fun freshnessColor(f: String): Color = when (f) { "live" -> Success; "delayed" -> Warning; else -> Color(0xFF64748B) }
private fun hue(d: JSONObject): Float = when {
    d.optString("freshness") !in listOf("live", "delayed") -> BitmapDescriptorFactory.HUE_VIOLET
    d.optString("availability") == "on_ride" -> BitmapDescriptorFactory.HUE_AZURE
    d.optString("freshness") == "delayed" -> BitmapDescriptorFactory.HUE_ORANGE
    else -> BitmapDescriptorFactory.HUE_GREEN
}
private fun describe(d: JSONObject): String {
    val age = d.optLong("age_seconds")
    val seen = if (age < 60) "${age}s ago" else "${age / 60} min ago"
    val ride = if (d.isNull("booking_code")) "No active ride" else "${d.optString("booking_code")} · ${label(d.optString("booking_status"))}"
    return "$ride · ${d.optInt("speed_kmh")} km/h · seen $seen"
}

/**
 * Live positions of on-duty drivers (the same server function as the web console), refreshed every 10 seconds.
 * Positions are exactly what drivers' phones reported; old positions are marked as delayed or stale, never shown as live.
 */
@Composable
fun MapScreen(vm: AppViewModel) {
    var drivers by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var loadedOnce by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    val context = LocalContext.current
    var myLocation by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) }
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> myLocation = granted }

    LaunchedEffect(reload) {
        while (true) {
            loading = true
            try {
                val snap = vm.api.rpc("tracking_snapshot", JSONObject().put("p_city_id", JSONObject.NULL).put("p_search", JSONObject.NULL).put("p_include_offline", false)) as? JSONObject
                drivers = snap?.optJSONArray("drivers")?.objects().orEmpty().filter { !it.isNull("lat") && !it.isNull("lng") }
                loadedOnce = true
            } catch (e: Exception) {
                vm.fail(e)
            }
            loading = false
            delay(10_000)
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${drivers.size} driver(s) sharing location", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            if (BuildConfig.MAPS_CONFIGURED && !myLocation) IconButton(onClick = { askLocation.launch(Manifest.permission.ACCESS_FINE_LOCATION) }) { Icon(Icons.Filled.Place, contentDescription = "Show my own position on the map") }
            IconButton(onClick = { reload++ }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
        }
        if (loading && !loadedOnce) LinearProgressIndicator(Modifier.fillMaxWidth())

        if (!BuildConfig.MAPS_CONFIGURED) {
            Surface(color = Warning.copy(alpha = 0.12f), modifier = Modifier.fillMaxWidth()) {
                Text("The map is not configured in this build (MAPS_API_KEY is empty), so drivers are shown as a list. See SETUP.md.", modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
            }
            DriverList(drivers, loadedOnce)
        } else {
            val camera = rememberCameraPositionState { position = CameraPosition.fromLatLngZoom(LatLng(22.5, 79.0), 4.5f) }
            var fitted by remember { mutableStateOf(false) }
            LaunchedEffect(drivers.isNotEmpty()) {
                if (!fitted && drivers.isNotEmpty()) {
                    val bounds = LatLngBounds.builder().apply { drivers.forEach { include(LatLng(it.optDouble("lat"), it.optDouble("lng"))) } }.build()
                    runCatching {
                        if (drivers.size == 1) camera.move(CameraUpdateFactory.newLatLngZoom(bounds.center, 14f))
                        else camera.move(CameraUpdateFactory.newLatLngBounds(bounds, 120))
                    }
                    fitted = true
                }
            }
            Box(Modifier.fillMaxSize()) {
                GoogleMap(
                    modifier = Modifier.fillMaxSize(),
                    cameraPositionState = camera,
                    properties = MapProperties(isMyLocationEnabled = myLocation),
                    uiSettings = MapUiSettings(myLocationButtonEnabled = myLocation, zoomControlsEnabled = true, mapToolbarEnabled = false),
                ) {
                    drivers.forEach { d ->
                        Marker(
                            state = MarkerState(position = LatLng(d.optDouble("lat"), d.optDouble("lng"))),
                            title = "${d.optString("full_name")} (${d.optString("driver_code")})",
                            snippet = describe(d),
                            icon = BitmapDescriptorFactory.defaultMarker(hue(d)),
                        )
                    }
                }
                if (loadedOnce && drivers.isEmpty()) Surface(Modifier.align(Alignment.TopCenter).padding(12.dp), shape = MaterialTheme.shapes.medium, tonalElevation = 3.dp) {
                    Text("No driver is sharing a location right now.", modifier = Modifier.padding(12.dp))
                }
            }
        }
    }
}

@Composable
private fun DriverList(drivers: List<JSONObject>, loaded: Boolean) {
    if (loaded && drivers.isEmpty()) { MessageScreen("No drivers on the map", "No driver is sharing a location right now."); return }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(drivers, key = { it.optString("driver_id") }) { d ->
            SectionCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${d.optString("full_name")} (${d.optString("driver_code")})", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Pill(label(d.optString("freshness")), freshnessColor(d.optString("freshness")))
                }
                Text(describe(d), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("%.5f, %.5f".format(d.optDouble("lat"), d.optDouble("lng")), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
