package com.example.ui

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.TouchApp
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.model.ActionHistoryItem
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun HistoryScreen(
    prefs: AriaPreferences,
    modifier: Modifier = Modifier
) {
    val history by prefs.historyState.collectAsState()
    var selectedFilter by remember { mutableStateOf("ALL") }
    var showClearConfirm by remember { mutableStateOf(false) }

    val filteredHistory = when (selectedFilter) {
        "SAFETY" -> history.filter { it.status == "REFUSED_SAFETY" || it.actionType == "SAFETY_REFUSAL" }
        "AUTOMATION" -> history.filter { it.actionType in listOf("TAP", "SWIPE", "TYPE", "OPEN_APP", "SYSTEM") }
        "INTENTS" -> history.filter { it.actionType in listOf("CALL", "SMS", "WHATSAPP", "ALARM", "TIMER", "NAVIGATION", "FLASHLIGHT") }
        else -> history
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Action History",
                        style = MaterialTheme.typography.headlineSmall,
                        color = Color.White,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "Audit log of all actions and safety decisions taken by Aria.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color(0xFF8B949E)
                    )
                }

                if (history.isNotEmpty()) {
                    IconButton(onClick = { showClearConfirm = true }) {
                        Icon(
                            imageVector = Icons.Default.Delete,
                            contentDescription = "Clear History",
                            tint = Color(0xFFF85149)
                        )
                    }
                }
            }
        }

        // Filter chips
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(
                    "ALL" to "All (${history.size})",
                    "SAFETY" to "Safety Shield",
                    "AUTOMATION" to "Gestures",
                    "INTENTS" to "Intents"
                ).forEach { (key, label) ->
                    FilterChip(
                        selected = selectedFilter == key,
                        onClick = { selectedFilter = key },
                        label = { Text(label, fontSize = 12.sp) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = Color(0xFF1F6FEB),
                            selectedLabelColor = Color.White,
                            containerColor = Color(0xFF161B22),
                            labelColor = Color(0xFF8B949E)
                        )
                    )
                }
            }
        }

        if (filteredHistory.isEmpty()) {
            item {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Icon(
                            imageVector = Icons.Default.History,
                            contentDescription = null,
                            tint = Color.Gray,
                            modifier = Modifier.size(48.dp)
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        Text(
                            text = "No recorded actions yet",
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "When Aria performs gestures, reads screens, or prevents unauthorized banking actions, records will appear here.",
                            fontSize = 12.sp,
                            color = Color(0xFF8B949E),
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center
                        )
                    }
                }
            }
        } else {
            items(filteredHistory, key = { it.id }) { item ->
                ActionHistoryCard(item)
            }
        }
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text("Clear Action History?", color = Color.White) },
            text = { Text("This will permanently remove all logged action history records.", color = Color.LightGray) },
            confirmButton = {
                Button(
                    onClick = {
                        prefs.clearHistory()
                        showClearConfirm = false
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFDA3633))
                ) {
                    Text("Clear All")
                }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) {
                    Text("Cancel", color = Color.Gray)
                }
            },
            containerColor = Color(0xFF161B22)
        )
    }
}

@Composable
private fun ActionHistoryCard(item: ActionHistoryItem) {
    val dateStr = remember(item.timestamp) {
        val sdf = SimpleDateFormat("MMM dd, HH:mm:ss", Locale.getDefault())
        sdf.format(Date(item.timestamp))
    }

    val (badgeBg, badgeColor, icon) = when (item.status) {
        "REFUSED_SAFETY" -> Triple(Color(0xFFDA3633).copy(alpha = 0.2f), Color(0xFFF85149), Icons.Default.Security)
        "CONFIRMATION_REQUIRED" -> Triple(Color(0xFFD29922).copy(alpha = 0.2f), Color(0xFFE3B341), Icons.Default.Warning)
        "CANCELLED" -> Triple(Color(0xFF484F58).copy(alpha = 0.2f), Color(0xFF8B949E), Icons.Default.History)
        else -> Triple(Color(0xFF238636).copy(alpha = 0.2f), Color(0xFF3FB950), Icons.Default.TouchApp)
    }

    Card(
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.Top
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(badgeBg),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = badgeColor,
                    modifier = Modifier.size(18.dp)
                )
            }

            Spacer(modifier = Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(Color(0xFF21262D))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Text(
                            text = item.actionType,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFF58A6FF)
                        )
                    }

                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = item.status,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = badgeColor
                    )

                    Spacer(modifier = Modifier.weight(1f))
                    Text(
                        text = dateStr,
                        fontSize = 11.sp,
                        color = Color(0xFF8B949E)
                    )
                }

                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = item.description,
                    color = Color.White,
                    fontSize = 13.sp,
                    lineHeight = 18.sp
                )

                if (item.details.isNotBlank()) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = item.details,
                        color = Color(0xFF8B949E),
                        fontSize = 12.sp
                    )
                }
            }
        }
    }
}
